// The finite relay-network exercise, invoked with npm run test:network.
// A private manifest precedes every claim so cleanup also covers lost replies.
// Only run-created relays receive writes; external sources only receive reads.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { encrypt } from "nostr-tools/nip04";
import { rpc, request, sample, clientMetrics } from "./network-client.mjs";

export const ROLES = ["peer-a", "peer-b", "satellite", "personal", "hub"];
export const EXTERNAL = ["wss://relay.damus.io", "wss://nos.lol"];
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secret = (actor) => Uint8Array.from(Buffer.from(actor.secret, "hex"));
const key = (m, node) => secret(m.actors[node.owner]);
const log = (s) => console.log(new Date().toISOString() + " " + s);

export function manifest(domain = "bind.ws") {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(domain)) throw new Error("invalid: domain must be a DNS hostname");
  const id = randomBytes(6).toString("hex");
  const actors = Object.fromEntries(["alice", "bob", "carole", "agent", "larry"].map((name) => {
    const sk = generateSecretKey();
    return [name, { secret: Buffer.from(sk).toString("hex"), pubkey: getPublicKey(sk) }];
  }));
  return { version: 1, id, domain, createdAt: new Date().toISOString(), actors,
    nodes: ROLES.map((role, i) => ({ role, owner: ["alice", "bob", "carole", "alice", "carole"][i],
      slug: `net-${id}-${role}`, url: `https://net-${id}-${role}.${domain}/`, state: "planned" })) };
}

// validateManifest prevents recovery from following arbitrary addresses in a file.
export function validateManifest(m) {
  if (m.version !== 1 || !/^[a-f0-9]{12}$/.test(m.id) || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(m.domain)) throw new Error("invalid: network manifest identity");
  if (!Array.isArray(m.nodes) || m.nodes.length !== ROLES.length) throw new Error("invalid: network manifest nodes");
  for (const [i, node] of m.nodes.entries()) {
    const slug = `net-${m.id}-${ROLES[i]}`;
    if (node.role !== ROLES[i] || node.slug !== slug || node.url !== `https://${slug}.${m.domain}/`) throw new Error("invalid: network manifest target");
    const actor = m.actors[node.owner];
    if (!actor || !/^[a-f0-9]{64}$/.test(actor.secret) || getPublicKey(secret(actor)) !== actor.pubkey) throw new Error("invalid: network manifest owner");
    if (!["planned", "claiming", "claimed", "deleted"].includes(node.state)) throw new Error("invalid: network manifest state");
  }
  return m;
}

export async function save(path, value) {
  await writeFile(path + ".tmp", JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(path + ".tmp", path);
}

// cleanup verifies ownership through an authenticated uncached call before deletion.
// An unclaimed response also resolves a claim or delete whose reply was lost.
export async function cleanup(m, persist, call = rpc) {
  validateManifest(m);
  const results = [];
  for (const node of [...m.nodes].reverse()) {
    if (node.state === "planned" || node.state === "deleted") continue;
    try {
      let p;
      let unclaimed = false;
      try { p = await call(node, key(m, node), "getpolicy"); }
      catch (e) {
        if (e.status !== 403 || e.message !== "restricted: this relay is unclaimed") throw e;
        unclaimed = true;
      }
      if (!unclaimed) {
        if (!p || p.owner !== m.actors[node.owner].pubkey) throw new Error("restricted: cleanup owner mismatch");
        const r = await call(node, key(m, node), "deleterelay", node.slug);
        if (r?.deleted !== true || r.name !== node.slug) throw new Error("error: deletion was not acknowledged");
      }
      node.state = "deleted";
      delete node.cleanupError;
      results.push({ role: node.role, deleted: true });
    } catch (e) {
      node.cleanupError = e.message;
      results.push({ role: node.role, deleted: false, error: e.message });
    }
    await persist();
  }
  return results;
}

export function usageDelta(before, after) {
  const delta = {};
  for (const k of Object.keys(after ?? {})) {
    if (typeof after[k] === "number" && typeof before?.[k] === "number") delta[k] = after[k] - before[k];
    else if (after[k] && typeof after[k] === "object" && !Array.isArray(after[k])) delta[k] = usageDelta(before?.[k], after[k]);
  }
  return delta;
}

async function run(dir, domain) {
  await mkdir(dir, { recursive: false, mode: 0o700 });
  const m = manifest(domain);
  const manifestPath = join(dir, "manifest.json");
  const reportPath = join(dir, "report.json");
  const persist = () => save(manifestPath, m);
  const report = { version: 1, id: m.id, startedAt: m.createdAt, domain, nodes: [], checks: [], jobs: [], external: [], fixtures: [], actors: Object.fromEntries(Object.entries(m.actors).map(([name, actor]) => [name, actor.pubkey])),
    limits: { relays: 5, externalSources: 2, externalAuthorsPerSource: 3, jobTimeoutSeconds: 120, runTimeoutSeconds: 1200 },
    assumptions: { size: "five small relays; external sources treated as much larger, their size is not measured", activity: "short bursts, idle gaps, catch-up and repeat sync; no load or capacity claim", privacy: "public tasks and results, encrypted kind-4 message held only at personal relay" } };
  const checkpoint = async () => { await persist(); await save(reportPath, report); };
  await checkpoint();
  log(`Manifest: ${manifestPath}`);
  let interrupted = false;
  const stop = () => { interrupted = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const deadline = Date.now() + 1200000;
  const active = () => { if (interrupted || Date.now() > deadline) throw new Error("error: network exercise interrupted or timed out"); };
  const node = (role) => m.nodes.find((n) => n.role === role);
  const call = (n, method, ...args) => rpc(n, key(m, n), method, ...args);
  const ws = (n) => n.url.replace("https:", "wss:").replace(/\/$/, "");
  const authors = [m.actors.alice.pubkey, m.actors.bob.pubkey];
  const event = (actor, text, kind = 1, tags = []) => {
    const e = finalizeEvent({ kind, content: text, created_at: now(), tags: [["t", `bindws-network-${m.id}`], ["expiration", String(now() + 3600)], ...tags] }, secret(m.actors[actor]));
    report.fixtures.push(e);
    return e;
  };
  const publish = async (n, e, actor) => {
    active();
    const r = await request(n.url + "events", secret(m.actors[actor]), e);
    if (!r.accepted) throw new Error(r.message ?? "error: event refused");
    return e;
  };
  const query = (n, ids, actor = n.owner) => request(n.url + "query", secret(m.actors[actor]), [{ ids, limit: 100 }]);
  const check = async (name, fn) => {
    active();
    log(name);
    const start = Date.now();
    try { const detail = await fn(); report.checks.push({ name, passed: true, milliseconds: Date.now() - start, detail }); }
    catch (e) { report.checks.push({ name, passed: false, milliseconds: Date.now() - start, error: e.message }); log(`FAILED: ${e.message}`); }
    await checkpoint();
  };
  const expectIds = async (n, ids, actor) => {
    const found = (await query(n, ids, actor)).map((e) => e.id);
    if (found.length !== ids.length || ids.some((id) => !found.includes(id))) throw new Error(`error: ${n.role} has ${found.length}/${ids.length} expected events`);
    return { expected: ids, found };
  };
  const absent = async (n, ids, actor) => {
    const found = await query(n, ids, actor);
    if (found.length) throw new Error(`error: ${n.role} exposed ${found.length} excluded events`);
    return { excluded: ids };
  };
  const job = async (n, kind, urls, filter, label, strict = true) => {
    active();
    const start = Date.now();
    const j = await call(n, "addjob", { kind, relays: urls, filter, every: 0 });
    const entry = { role: n.role, label, id: j.id, kind, relays: urls, filter };
    report.jobs.push(entry);
    await checkpoint();
    try {
      while (Date.now() - start < 120000) {
        active();
        const state = (await call(n, "listjobs")).find((x) => x.id === j.id);
        if (!state) throw new Error("error: job disappeared");
        if (!state.running && state.nextRun === 0 && state.last) {
          entry.result = state.last;
          entry.targetStatus = state.targetStatus;
          entry.milliseconds = Date.now() - start;
          if (strict && (state.last.error || state.last.refused || state.last.sources?.some((s) => s.status === "failed" || s.status === "refused" || s.partial))) throw new Error(`error: ${label}: ${state.last.error || "partial or refused sync"}`);
          return entry;
        }
        await sleep(1500);
      }
      throw new Error(`error: ${label} exceeded 120 seconds`);
    } catch (e) { entry.error = e.message; throw e; }
    finally { await call(n, "removejob", j.id); await checkpoint(); }
  };
  try {
    for (const n of m.nodes) {
      active();
      n.state = "claiming";
      await persist();
      const r = await call(n, "claim");
      if (!r.claimed || r.owner !== m.actors[n.owner].pubkey) throw new Error("restricted: generated relay was not claimed by this run");
      n.state = "claimed";
      await persist();
      // Quiet disables unsolicited delivery, notifications and unrelated features.
      await call(n, "applypreset", "quiet");
      await call(n, "setpolicy", { writes: "allowlist", reads: "open", directoryPublic: false, guestReplies: false, openKinds: [], features: { sync: true, count: true } });
      for (const actor of ({ "peer-a": ["bob"], "peer-b": ["alice"], satellite: [], personal: ["agent"], hub: ["alice", "agent"] })[n.role]) if (actor !== n.owner) await call(n, "setmember", m.actors[actor].pubkey, { name: actor });
      const baseline = await call(n, "stats");
      report.nodes.push({ role: n.role, url: n.url, owner: m.actors[n.owner].pubkey, baseline, policy: await call(n, "getpolicy") });
      log(`Created ${n.role}: ${n.url}`);
      await checkpoint();
    }
    const a = node("peer-a"), b = node("peer-b"), personal = node("personal"), hub = node("hub"), satellite = node("satellite");
    const filter = { authors, kinds: [1], since: now() - 60 };
    const peerEvents = [];
    await check("equal peers converge in both directions", async () => {
      for (let i = 0; i < 4; i++) {
        peerEvents.push(await publish(a, event("alice", `peer a note ${i}`), "alice"));
        peerEvents.push(await publish(b, event("bob", `peer b note ${i}`), "bob"));
      }
      await job(a, "pull", [ws(b)], filter, "b to a");
      await job(b, "pull", [ws(a)], filter, "a to b");
      const ids = peerEvents.map((e) => e.id);
      return [await expectIds(a, ids), await expectIds(b, ids)];
    });
    await check("repeat sync has no duplicate events", async () => {
      await job(a, "pull", [ws(b)], filter, "repeat b to a");
      const ids = peerEvents.map((e) => e.id);
      await publish(a, peerEvents[0], "alice");
      return expectIds(a, ids);
    });
    await check("an idle peer catches up with the next burst", async () => {
      await sleep(2500);
      const events = [];
      for (let i = 0; i < 3; i++) events.push(await publish(a, event("alice", `catch-up ${i}`), "alice"));
      await absent(b, events.map((e) => e.id));
      await job(b, "pull", [ws(a)], filter, "catch-up a to b");
      return expectIds(b, [...peerEvents, ...events].map((e) => e.id));
    });
    await check("the personal relay exchanges selected notes with the peer network", async () => {
      const note = await publish(personal, event("alice", "public personal note for the small peer network"), "alice");
      await job(personal, "push", [ws(a)], { authors: [m.actors.alice.pubkey], kinds: [1] }, "personal to peer a");
      await job(b, "pull", [ws(a)], filter, "personal note through peer a to b");
      await expectIds(b, [note.id]);
      await job(personal, "pull", [ws(b)], { authors: [m.actors.bob.pubkey], kinds: [1] }, "bob from peer network to personal");
      return expectIds(personal, peerEvents.filter((e) => e.pubkey === m.actors.bob.pubkey).map((e) => e.id));
    });
    let privateEvent;
    await check("personal tasks reach the hub and agent results return", async () => {
      const task = await publish(personal, event("alice", "public task: count the words in this synthetic note"), "alice");
      privateEvent = await publish(personal, event("alice", await encrypt(secret(m.actors.alice), m.actors.bob.pubkey, "synthetic private note"), 4, [["p", m.actors.bob.pubkey]]), "alice");
      await job(personal, "push", [ws(hub)], { authors: [m.actors.alice.pubkey], kinds: [1] }, "personal tasks to hub");
      await expectIds(hub, [task.id], "agent");
      const result = await publish(hub, event("agent", "public result: synthetic task complete", 1, [["e", task.id], ["p", m.actors.alice.pubkey]]), "agent");
      await job(personal, "pull", [ws(hub)], { authors: [m.actors.agent.pubkey], kinds: [1] }, "agent results to personal");
      return { task: task.id, result: result.id, received: await expectIds(personal, [result.id]), privateExcluded: await absent(hub, [privateEvent.id], "bob") };
    });
    await check("private messages stay visible only to their parties", async () => {
      if (!privateEvent) throw new Error("error: private fixture was not published");
      return { recipient: await expectIds(personal, [privateEvent.id], "bob"), stranger: await absent(personal, [privateEvent.id], "larry") };
    });
    await check("non-member writes and management are refused", async () => {
      for (const n of [a, personal, hub]) {
        try { await publish(n, event("larry", "unauthorized synthetic write"), "larry"); throw new Error("error: unauthorized write accepted"); }
        catch (e) { if (e.status !== 400 || !/restricted:|blocked:|auth-required:/.test(e.message)) throw e; }
        try { await rpc(n, secret(m.actors.larry), "setpolicy", { writes: "open" }); throw new Error("error: unauthorized management accepted"); }
        catch (e) { if (e.status !== 403 || !e.message.startsWith("restricted:")) throw e; }
      }
    });
    await check("author and kind filters exclude unrelated hub data", async () => {
      const unrelated = await publish(hub, event("carole", "hub local note"), "carole");
      const metadata = await publish(hub, event("agent", JSON.stringify({ name: "synthetic agent" }), 0), "agent");
      await job(personal, "pull", [ws(hub)], { authors: [m.actors.agent.pubkey], kinds: [1] }, "filtered hub repeat");
      return absent(personal, [unrelated.id, metadata.id]);
    });
    await check("members-only sources report a refused unauthenticated pull", async () => {
      await call(hub, "setpolicy", { reads: "members" });
      try {
        const r = await job(personal, "pull", [ws(hub)], { authors: [m.actors.agent.pubkey], kinds: [1] }, "restricted source", false);
        if (!r.result.sources?.some((s) => s.status === "refused")) throw new Error("error: restricted source was not classified as refused");
        return r.result;
      } finally { await call(hub, "setpolicy", { reads: "open" }); }
    });
    for (const source of EXTERNAL) {
      active();
      log(`Read-only external sample: ${source}`);
      const selection = await sample(source, { kinds: [0], since: now() - 86400, limit: 3 }, 3);
      const entry = { source, sampling: { status: selection.status, error: selection.error }, sampledIds: selection.events.map((e) => e.id), authors: [...new Set(selection.events.map((e) => e.pubkey))] };
      report.external.push(entry);
      if (!entry.authors.length) { entry.outcome = "inconclusive: no public sample"; await checkpoint(); continue; }
      try {
        const j = await job(satellite, "pull", [source], { authors: entry.authors, kinds: [0], since: now() - 86400 }, `external ${source}`, false);
        const received = await request(satellite.url + "query", key(m, satellite), [{ authors: entry.authors, kinds: [0], limit: 10 }]);
        entry.receivedIds = received.map((e) => e.id);
        entry.job = j.result;
        entry.outcome = received.length ? "observed public profile import" : "inconclusive: no matching profiles imported";
      } catch (e) { entry.outcome = "inconclusive: " + e.message; }
      if (entry.receivedIds?.length) {
        await check("selected satellite profiles reach the agent hub", async () => {
          const context = await job(hub, "pull", [ws(satellite)], { authors: entry.authors, kinds: [0] }, "satellite profile context to hub");
          entry.hubContext = { job: context.result, received: await expectIds(hub, entry.receivedIds) };
          return entry.hubContext;
        });
      }
      await checkpoint();
    }
    await check("the external satellite stays separate from synthetic peer traffic", async () => absent(satellite, peerEvents.map((e) => e.id)));
  } catch (e) {
    report.error = e.message;
    log(e.message);
  } finally {
    log("Extracting final usage and tearing down run-created relays");
    for (const n of m.nodes.filter((n) => n.state === "claimed")) {
      const entry = report.nodes.find((x) => x.role === n.role);
      try {
        const stats = await call(n, "stats");
        if (entry) { entry.storage = await call(n, "storagestats"); entry.final = stats; entry.usageDelta = usageDelta(entry.baseline.fuel, stats.fuel); }
      } catch (e) { if (entry) entry.extractionError = e.message; }
    }
    report.cleanup = await cleanup(m, persist);
    report.client = { ...clientMetrics };
    report.finishedAt = new Date().toISOString();
    report.passed = !report.error && report.checks.length > 0 && report.checks.every((c) => c.passed) && report.cleanup.every((c) => c.deleted) && !report.nodes.some((n) => n.extractionError);
    await checkpoint();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  log(`${report.passed ? "PASS" : "FAIL"}: ${report.checks.filter((c) => c.passed).length}/${report.checks.length} checks; report ${reportPath}`);
  if (!report.passed) process.exitCode = 1;
}

export async function main(args) {
  const [command, target, domain, ...extra] = args;
  if (extra.length || !["run", "cleanup", "plan"].includes(command)) {
    console.log("npm run test:network -- plan\nnpm run test:network -- run [new-output-directory] [domain]\nnpm run test:network -- cleanup <output-directory>");
    if (command && command !== "--help") process.exitCode = 1;
    return;
  }
  if (command === "plan") {
    console.log(JSON.stringify({ roles: ROLES, externalReadOnly: EXTERNAL, run: "finite one-shot jobs, no schedule", cleanup: "finally and recoverable manifest", assertions: "peer convergence, dedup, catch-up, task/result filters, privacy and access refusal" }, null, 2));
    return;
  }
  if (command === "cleanup") {
    if (!target || domain) throw new Error("invalid: cleanup needs one output directory");
    const path = join(resolve(target), "manifest.json");
    const m = validateManifest(JSON.parse(await readFile(path, "utf8")));
    const results = await cleanup(m, () => save(path, m));
    await save(join(resolve(target), "cleanup.json"), results);
    console.log(JSON.stringify(results, null, 2));
    if (results.some((r) => !r.deleted)) process.exitCode = 1;
    return;
  }
  const root = join(homedir(), ".local", "share", "bindws", "network-tests");
  if (!target) await mkdir(root, { recursive: true, mode: 0o700 });
  await run(target ? resolve(target) : join(root, new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(3).toString("hex")), domain ?? "bind.ws");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
