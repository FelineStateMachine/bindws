// The manually invoked network test client: signed management calls and a
// bounded, read-only WebSocket sample. It keeps retries narrow because a
// mutation whose result is unclear must remain visible to the harness.
import WebSocket from "ws";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";

const REQUEST_TIMEOUT = 20_000;
const SAMPLE_TIMEOUT = 15_000;
const SAMPLE_BYTES = 256 * 1024;
const RETRIES = 30;
const RETRY_DELAY = 500;
const RETRY_MAX_WAIT = 2_000;
const RETRY_WINDOW = 60_000;

export const clientMetrics = { requests: 0, operationRetries: 0, operationWaitMs: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class NetworkError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "NetworkError";
    this.status = status;
    this.body = body;
  }
}

const parseBody = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const retryable = (status, body) => {
  if (status !== 429) return false;
  const reason = body && typeof body === "object"
    ? `${body.error ?? ""} ${body.message ?? ""}`
    : String(body ?? "");
  return /operation in progress/i.test(reason);
};

const errorText = (body) => {
  if (body && typeof body === "object") return String(body.error ?? body.message ?? "request failed").slice(0, 300);
  return String(body ?? "request failed").slice(0, 300);
};

// request sends one signed JSON POST and returns its parsed response. Only a
// relay's explicit transient operation refusal is retried; timeout, network
// and other HTTP failures remain errors because their mutation outcome is
// unknown.
export async function request(node, sk, body, rpc = false) {
  const url = typeof node === "string" ? node : node.url;
  const payload = body ?? {};
  const retryUntil = Date.now() + RETRY_WINDOW;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      clientMetrics.requests++;
      const authorization = await getToken(url, "POST", (event) => finalizeEvent(event, sk), true, payload);
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": rpc ? "application/nostr+json+rpc" : "application/json", authorization },
        body: JSON.stringify(payload),
      });
      const result = await parseBody(response);
      if (response.ok) return result;
      if (retryable(response.status, result) && attempt < RETRIES && Date.now() < retryUntil) {
        const delay = Math.min(RETRY_MAX_WAIT, RETRY_DELAY * (attempt + 1), retryUntil - Date.now());
        if (delay <= 0) throw new NetworkError(errorText(result), response.status, result);
        clientMetrics.operationRetries++;
        clientMetrics.operationWaitMs += delay;
        await sleep(delay);
        continue;
      }
      throw new NetworkError(errorText(result), response.status, result);
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      throw new NetworkError(error instanceof Error ? error.message : String(error), 0, null);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new NetworkError("request retries exhausted", 429, null);
}

// rpc calls one NIP-86 method and returns its result. A relay error remains a
// NetworkError so the harness can stop before issuing the next mutation.
export async function rpc(node, sk, method, ...params) {
  const response = await request(node, sk, { method, params }, true);
  if (response && typeof response === "object" && "error" in response) {
    throw new NetworkError(errorText(response), 200, response);
  }
  return response && typeof response === "object" && "result" in response ? response.result : response;
}

const validSample = (event, filter) => {
  if (!event || typeof event !== "object" || !verifyEvent(event)) return false;
  if (filter.kinds?.length && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  if (filter.authors?.length && !filter.authors.includes(event.pubkey)) return false;
  return true;
};

// sample reads at most limit valid signed events from a relay. It never
// answers AUTH or sends EVENT. An authenticated source is allowed to complete
// its read or refuse it. Incoming data and time are bounded for endpoints.
export function sample(url, filter = {}, limit = 3) {
  const requested = { ...filter, kinds: filter.kinds?.length ? [...filter.kinds] : [1], limit: Math.min(Math.max(limit, 1), 3) };
  const wsURL = url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return new Promise((resolve) => {
    const events = [];
    let settled = false;
    let timer;
    let socket;
    const finish = (status, error = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        socket.removeAllListeners("open");
        socket.removeAllListeners("message");
        try {
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) socket.close();
          else socket.terminate();
        } catch {
          try { socket.terminate(); } catch { /* already closed */ }
        }
      }
      resolve({ events, status, error });
    };
    try {
      socket = new WebSocket(wsURL, { maxPayload: SAMPLE_BYTES, followRedirects: false });
      socket.on("open", () => socket.send(JSON.stringify(["REQ", "network-sample", requested])));
      socket.on("message", (data) => {
        if (settled) return;
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        if (raw.length > SAMPLE_BYTES) return finish("failed", "sample response exceeded 256 KiB");
        let message;
        try { message = JSON.parse(raw.toString("utf8")); } catch { return; }
        if (!Array.isArray(message)) return;
        if (message[0] === "AUTH") return;
        if (message[0] === "CLOSED") return finish("refused", String(message[2] ?? "source refused query").slice(0, 300));
        if (message[0] === "EOSE" && message[1] === "network-sample") return finish("complete");
        if (message[0] !== "EVENT" || message[1] !== "network-sample") return;
        let valid = false;
        try { valid = validSample(message[2], requested); } catch { return; }
        if (!valid) return;
        if (!events.some((event) => event.id === message[2].id)) events.push(message[2]);
        if (events.length >= requested.limit) finish("limit");
      });
      socket.on("error", (error) => finish("failed", error.message.slice(0, 300)));
      socket.on("close", () => finish(events.length ? "partial" : "failed", events.length ? "source closed before EOSE" : "connection closed"));
      timer = setTimeout(() => finish("timeout", "source did not answer within 15 seconds"), SAMPLE_TIMEOUT);
    } catch (error) {
      finish("failed", error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300));
    }
  });
}
