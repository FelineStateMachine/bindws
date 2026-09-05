import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
// @ts-expect-error the production-only helper is JavaScript by design.
import { request, sample } from "../../scripts/ops/network-client.mjs";

const key = generateSecretKey();

describe("network test client", () => {
  it("does not retry an ambiguous mutation response", async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "error: upstream unavailable" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
    await expect(request({ url }, key, { mutation: true })).rejects.toMatchObject({ status: 503, message: "error: upstream unavailable" });
    expect(calls).toBe(1);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("retries an explicit operation-in-progress refusal and returns the response", async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      res.writeHead(calls === 1 ? 429 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(calls === 1 ? { error: "restricted: relay operation in progress; retry" } : { result: { ok: true } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
    await expect(request({ url }, key, { method: "stats", params: [] }, true)).resolves.toEqual({ result: { ok: true } });
    expect(calls).toBe(2);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("samples signed events after an unsolicited auth challenge without publishing", async () => {
    const server = new WebSocketServer({ port: 0 });
    let clientMessages: string[] = [];
    const event = finalizeEvent({ kind: 0, content: JSON.stringify({ name: "sample" }), tags: [], created_at: Math.floor(Date.now() / 1000) }, key);
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        clientMessages.push(data.toString());
        socket.send(JSON.stringify(["AUTH", "challenge"]));
        socket.send(JSON.stringify(["EVENT", "network-sample", { id: "bad" }]));
        socket.send(JSON.stringify(["EVENT", "network-sample", event]));
        socket.send(JSON.stringify(["EOSE", "network-sample"]));
      });
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    const result = await sample(`ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, { kinds: [0] });
    expect(result.status).toBe("complete");
    expect(result.events.map((x: { id: string }) => x.id)).toEqual([event.id]);
    expect(clientMessages).toHaveLength(1);
    expect(clientMessages[0]).not.toContain("AUTH");
    expect(clientMessages[0]).not.toContain("EVENT");
    server.close();
  });

  it("reports a source that closes before completing its sample", async () => {
    const server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket) => socket.close());
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    const result = await sample(`ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("closed");
    server.close();
  });
});
