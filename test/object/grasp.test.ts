// The GRASP door: repository events name the service before Git answers, and
// pending authority stays out of ordinary relay reads until its data arrives.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { KIND_REPO, KIND_REPO_STATE, KIND_GIT_PR, KIND_GIT_PR_UPDATE } from "../../src/kinds.ts";
import { gitRepository } from "../../src/grasp.ts";
import { repository as storedRepository } from "../../src/grasp-state.ts";
import { gitRepositoryPath } from "../../src/grasp-policy.ts";
import { ev, info, pk, rpc, sleep } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";
import { decodePack, encodePack } from "ntig";

const encoder = new TextEncoder();
const packet = (value: string | Uint8Array) => {
  const body = typeof value === "string" ? encoder.encode(value) : value;
  const header = encoder.encode((body.length + 4).toString(16).padStart(4, "0"));
  return new Uint8Array([...header, ...body]);
};
const flush = () => new Uint8Array([48, 48, 48, 48]);
const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
const objectID = async (type: string, data: Uint8Array) => {
  const header = encoder.encode(`${type} ${data.length}\0`);
  const value = new Uint8Array(header.length + data.length);
  value.set(header); value.set(data, header.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", value)), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const receivePack = (path: string, host: string, old: string | null, next: string | null, ref: string, pack?: Uint8Array, requestId?: string) => SELF.fetch(`http://${host}${path}/git-receive-pack`, {
  method: "POST",
  headers: { "content-type": "application/x-git-receive-pack-request", ...(requestId ? { "X-Git-Request-Id": requestId } : {}) },
  body: concat(packet(`${old ?? "0".repeat(40)} ${next ?? "0".repeat(40)} ${ref}\0report-status\n`), flush(), ...(pack ? [pack] : [])),
});
// receiveSettled waits for transient alarm contention before testing the Git response.
const receiveSettled = async (path: string, host: string, old: string | null, next: string | null, ref: string, pack?: Uint8Array, requestId?: string) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await receivePack(path, host, old, next, ref, pack, requestId);
    if (response.status !== 429) return response;
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Git transaction did not become available");
};

async function tinyRepository(content = "hello from grasp\n") {
  const blob = encoder.encode(content);
  const blobID = await objectID("blob", blob);
  const tree = new Uint8Array([...encoder.encode("100644 README\0"), ...Uint8Array.from(blobID.match(/../g)!, (part) => parseInt(part, 16))]);
  const treeID = await objectID("tree", tree);
  const commit = encoder.encode(`tree ${treeID}\nauthor GRASP <grasp@example.com> 1 +0000\ncommitter GRASP <grasp@example.com> 1 +0000\n\ninitial\n`);
  const commitID = await objectID("commit", commit);
  const pack = await encodePack([{ type: "blob", data: blob }, { type: "tree", data: tree }, { type: "commit", data: commit }]);
  return { blobID, treeID, commitID, pack };
}

const repository = (sk: Uint8Array, host: string, identifier = "bindws") => {
  const npub = npubEncode(pk(sk));
  return ev(sk, KIND_REPO, "", [
    ["d", identifier],
    ["clone", `https://${host}${gitRepositoryPath(npub, identifier)}`],
    ["relays", `wss://${host}`],
    ["clone", `https://mirror.example/${identifier}.git`],
    ["relays", "wss://relay.example"],
    ["maintainers", pk(sk)],
  ]);
};

describe("GRASP", () => {
  afterEach(() => sleep(20));
  it("is opt in and advertises the Git contract only while it is on", async () => {
    const host = "grasp-feature.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");

    expect((await info(host)).supported_grasps).toBeUndefined();
    expect((await SELF.fetch(`http://${host}/npub1invalid/repo.git`)).status).toBe(404);

    expect((await rpc(host, owner, "setpolicy", { features: { grasp: true } })).status).toBe(200);
    const document = await info(host);
    expect(document.supported_grasps).toEqual(["GRASP-01"]);
    expect(document.repo_acceptance_criteria).toContain("clone and relays");
    expect(document.nsites).toBeDefined();
    expect((await rpc(host, owner, "setpolicy", { features: { grasp: false } })).status).toBe(200);
    expect((await info(host)).supported_grasps).toBeUndefined();
  });

  it("accepts a service-listed announcement with every clone and relay value", async () => {
    const host = "grasp-announcement.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { features: { grasp: true } });
    const c = await WS.connect(host);
    const event = repository(owner, host, "multi-source");
    const accepted = await c.ok(event);
    expect(accepted.ok, accepted.msg).toBe(true);

    const found = await c.open("repo", { kinds: [KIND_REPO], authors: [pk(owner)] });
    expect(found.events.map((e) => e.id)).not.toContain(event.id);
    c.ws.close();
  });

  it("rejects an announcement that does not list this relay in both services", async () => {
    const host = "grasp-rejection.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { features: { grasp: true } });
    const c = await WS.connect(host);
    const bad = ev(owner, KIND_REPO, "", [["d", "missing-service"], ["clone", "https://elsewhere.example/repo.git"], ["relays", "wss://elsewhere.example"]]);
    const result = await c.ok(bad);
    expect(result.ok).toBe(false);
    expect(result.msg).toMatch(/^restricted:/);
    c.ws.close();
  });

  it("keeps malformed Git paths CORS readable and answers preflight without opening a relay door", async () => {
    const host = "grasp-paths.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { features: { grasp: true } });
    const paths = ["/npub1invalid/repo.git", "/npub1invalid/repo.git/unknown", "/prs/anything.git"];
    for (const path of paths) {
      const response = await SELF.fetch(`http://${host}${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
    const options = await SELF.fetch(`http://${host}/npub1invalid/repo.git/info/refs`, { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("keeps a repository path separate from a site hostname", async () => {
    const host = "grasp-site-isolation.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const siteHost = `${npubEncode(pk(owner))}.bind.ws`;
    const siteResponse = await SELF.fetch(`http://${siteHost}/`);
    expect(siteResponse.status).toBe(404);
    expect((await SELF.fetch(`http://${siteHost}/repo.git`)).status).toBe(404);
  });

  it("serves and updates a state-authorized repository through Smart HTTP", async () => {
    const host = "grasp-git.bind.ws";
    const owner = generateSecretKey();
    const repo = repository(owner, host, "lifecycle");
    const pack = await tinyRepository();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { features: { grasp: true } });
    const c = await WS.connect(host);
    const repoResult = await c.ok(repo);
    expect(repoResult.ok, repoResult.msg).toBe(true);


    const state = ev(owner, KIND_REPO_STATE, "", [["d", "lifecycle"], ["HEAD", "ref: refs/heads/main"], ["refs/heads/main", pack.commitID]]);
    expect((await c.ok(state)).ok).toBe(true);

    c.ws.close();

    const path = gitRepositoryPath(npubEncode(pk(owner)), "lifecycle");
    const refs = await SELF.fetch(`http://${host}${path}/info/refs?service=git-upload-pack`);
    expect(refs.status).toBe(200);
    expect(await refs.text()).toContain("symref=HEAD:refs/heads/main");

    const receive = concat(packet(`${"0".repeat(40)} ${pack.commitID} refs/heads/main\0report-status\n`), flush(), pack.pack);
    const pushed = await SELF.fetch(`http://${host}${path}/git-receive-pack`, { method: "POST", headers: { "content-type": "application/x-git-receive-pack-request" }, body: receive });
    expect(pushed.status).toBe(200);
    expect(await pushed.text()).toContain("ok refs/heads/main");
    const visible = await WS.connect(host);
    expect((await visible.req({ ids: [repo.id, state.id] })).map((e) => e.id).sort()).toEqual([repo.id, state.id].sort());
    visible.ws.close();

    const advertised = await SELF.fetch(`http://${host}${path}/info/refs?service=git-upload-pack`);
    expect(await advertised.text()).toContain(`${pack.commitID} refs/heads/main`);

    const upload = concat(packet(`want ${pack.commitID}\n`), flush(), packet("done\n"));
    const fetched = await SELF.fetch(`http://${host}${path}/git-upload-pack`, { method: "POST", headers: { "content-type": "application/x-git-upload-pack-request" }, body: upload });
    expect(fetched.status).toBe(200);
    const bytes = new Uint8Array(await fetched.arrayBuffer());
    const objects = await decodePack(bytes.slice(8));
    expect(objects.map((object) => object.oid).sort()).toEqual([pack.blobID, pack.treeID, pack.commitID].sort());
  });

  it("refuses a receive update whose resulting refs differ from accepted state", async () => {
    const host = "grasp-state-gate.bind.ws";
    const owner = generateSecretKey();
    const repo = repository(owner, host, "state-gate");
    const pack = await tinyRepository();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { features: { grasp: true } });
    const c = await WS.connect(host);
    const repoResult = await c.ok(repo);
    expect(repoResult.ok, repoResult.msg).toBe(true);
    const state = ev(owner, KIND_REPO_STATE, "", [["d", "state-gate"], ["HEAD", "ref: refs/heads/main"], ["refs/heads/main", pack.commitID]]);
    expect((await c.ok(state)).ok).toBe(true); c.ws.close();
    const path = gitRepositoryPath(npubEncode(pk(owner)), "state-gate");
    const wrong = concat(packet(`${"0".repeat(40)} ${"f".repeat(40)} refs/heads/other\0report-status\n`), flush(), pack.pack);
    const response = await SELF.fetch(`http://${host}${path}/git-receive-pack`, { method: "POST", headers: { "content-type": "application/x-git-receive-pack-request" }, body: wrong });
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/ng|unpack/);
    const refs = await SELF.fetch(`http://${host}${path}/info/refs?service=git-upload-pack`);
    expect(await refs.text()).not.toContain("refs/heads/other");
  });

  it("holds unknown PR refs, checks published PR tips, and refuses anonymous deletion", async () => {
    const host = "grasp-pr-refs.bind.ws";
    const owner = generateSecretKey();
    const repo = repository(owner, host, "pr-refs");
    const pack = await tinyRepository();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { features: { grasp: true } });
    const c = await WS.connect(host);
    expect((await c.ok(repo)).ok).toBe(true);
    const state = ev(owner, KIND_REPO_STATE, "", [["d", "pr-refs"], ["HEAD", "ref: refs/heads/main"], ["refs/heads/main", pack.commitID]]);
    expect((await c.ok(state)).ok).toBe(true); c.ws.close();
    const path = gitRepositoryPath(npubEncode(pk(owner)), "pr-refs");

    expect((await receiveSettled(path, host, null, pack.commitID, "refs/heads/main", pack.pack)).status).toBe(200);
    const realPR = ev(owner, KIND_GIT_PR, "", [["a", `30617:${pk(owner)}:pr-refs`], ["c", pack.commitID]]);
    const unknownRef = `refs/nostr/${realPR.id}`;
    expect((await receiveSettled(path, host, null, pack.commitID, unknownRef, pack.pack)).status).toBe(200);
    expect(await (await SELF.fetch(`http://${host}${path}/info/refs?service=git-upload-pack`)).text()).toContain(`${pack.commitID} ${unknownRef}`);
    const deletion = await receiveSettled(path, host, pack.commitID, null, unknownRef);
    expect(deletion.status).toBe(200);
    expect(await deletion.text()).toContain(`ng ${unknownRef}`);

    const late = await WS.connect(host);
    expect((await late.ok(realPR)).ok).toBe(true);
    expect((await receiveSettled(path, host, pack.commitID, pack.commitID, "refs/heads/main")).status).toBe(200);
    expect((await late.req({ ids: [realPR.id] })).map((e) => e.id)).toEqual([realPR.id]);
    const listed = await SELF.fetch(`http://${host}${path}/info/refs?service=git-upload-pack`);
    expect(await listed.text()).toContain(`refs/nostr/${realPR.id}`);
    const wrongPR = ev(owner, KIND_GIT_PR, "", [["a", `30617:${pk(owner)}:pr-refs`], ["c", "b".repeat(40)]]);
    const wrongEvent = await WS.connect(host);
    expect((await wrongEvent.ok(wrongPR)).ok).toBe(true);
    const mismatch = await receiveSettled(path, host, null, pack.commitID, `refs/nostr/${wrongPR.id}`);
    expect(await mismatch.text()).toContain(`ng refs/nostr/${wrongPR.id}`);
    wrongEvent.ws.close();

    const expiringID = "c".repeat(64);
    const expiringRef = `refs/nostr/${expiringID}`;
    expect(await (await receiveSettled(path, host, null, pack.commitID, expiringRef, pack.pack)).text()).toContain(`ok ${expiringRef}`);
    await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), (relay) => {
      relay.sql.exec("UPDATE grasp_pr_refs SET until=0 WHERE repo=? AND ref=?", `30617:${pk(owner)}:pr-refs`, expiringRef);
    });
    await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), (relay) => relay.alarm());
    const afterExpiry = await SELF.fetch(`http://${host}${path}/info/refs?service=git-upload-pack`);
    expect(await afterExpiry.text()).not.toContain(expiringRef);
    late.ws.close();
  });

  it("replays a hidden PR correction after checkpointing and more than 128 later transactions", async () => {
    const host = "grasp-pr-checkpoint.bind.ws";
    const owner = generateSecretKey();
    const first = await tinyRepository();
    const next = await tinyRepository("corrected PR\n");
    await rpc(host, owner, "claim");
    await rpc(host, owner, "applypreset", "grasp");
    const c = await WS.connect(host);
    expect((await c.ok(repository(owner, host, "correction"))).ok).toBe(true);
    expect((await c.ok(ev(owner, KIND_REPO_STATE, "", [["d", "correction"], ["HEAD", "ref: refs/heads/main"], ["refs/heads/main", first.commitID]]))).ok).toBe(true);
    c.ws.close();
    const path = gitRepositoryPath(npubEncode(pk(owner)), "correction");
    expect(await (await receiveSettled(path, host, null, first.commitID, "refs/heads/main", first.pack, "benchmark-initial")).text()).toContain("ok refs/heads/main");
    const pr = ev(owner, KIND_GIT_PR, "", [["a", `30617:${pk(owner)}:correction`], ["c", next.commitID]]);
    const ref = `refs/nostr/${pr.id}`;
    expect(await (await receiveSettled(path, host, null, first.commitID, ref, undefined, "benchmark-unknown")).text()).toContain(`ok ${ref}`);
    const publisher = await WS.connect(host);
    expect((await publisher.ok(pr)).ok).toBe(true);
    publisher.ws.close();
    const hidden = await SELF.fetch(`http://${host}${path}/info/refs?service=git-upload-pack`);
    expect(await hidden.text()).not.toContain(ref);

    const stub = env.RELAY.getByName("grasp-pr-checkpoint");
    await runInDurableObject(stub, async (relay) => {
      await relay.repositoryAccess.run("git", async () => {
        const wal = await gitRepository(relay, storedRepository(relay, pk(owner), "correction")!);
        expect((await wal.checkpoint()).changed).toBe(true);
      }, () => { throw new Error("Git scope unexpectedly refused"); });
    });
    const metadata = await runInDurableObject(stub, async (relay) => {
      const bucket = relay.media;
      const keys: string[] = [];
      const observed = new Proxy(bucket, { get(target, name) {
        if (name === "get") return (key: string, options?: R2GetOptions) => { keys.push(key); return target.get(key, options); };
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      Object.defineProperty(relay, "media", { value: observed, configurable: true });
      try {
        const response = await relay.fetch(new Request(`http://${host}${path}/info/refs?service=git-upload-pack`));
        expect(response.status).toBe(200);
        return { body: await response.text(), keys };
      } finally { Reflect.deleteProperty(relay, "media"); }
    });
    expect(metadata.keys).toHaveLength(2);
    expect(metadata.keys[0]).toMatch(/\/root.json$/);
    expect(metadata.keys[1]).toContain("/manifests/");
    expect(metadata.body).toContain("symref=HEAD:refs/heads/main");
    expect(metadata.body).not.toContain(ref);
    const requestId = "hidden-pr-correction";
    expect(await (await receiveSettled(path, host, null, next.commitID, ref, next.pack, requestId)).text()).toContain(`ok ${ref}`);
    const sequence = await runInDurableObject(stub, async (relay) => {
      return relay.repositoryAccess.run("git", async () => {
        const wal = await gitRepository(relay, storedRepository(relay, pk(owner), "correction")!);
        for (let i = 0; i < 130; i++) await wal.commit({ id: `later-${i}`, updates: [{ name: `refs/tags/later-${i}`, old: null, new: first.commitID }] });
        const snapshot = await wal.load();
        expect(snapshot.records).toHaveLength(1);
        expect(snapshot.records[0].id).not.toBe(requestId);
        return snapshot.sequence;
      }, () => { throw new Error("Git scope unexpectedly refused"); });
    });
    // Pending work for another repository does not reload this one's packs.
    const other = await WS.connect(host);
    expect((await other.ok(repository(owner, host, "other"))).ok).toBe(true);
    expect((await other.ok(ev(owner, KIND_REPO_STATE, "", [["d", "other"], ["HEAD", "ref: refs/heads/main"], ["refs/heads/main", first.commitID]]))).ok).toBe(true);
    other.ws.close();
    const retried = await runInDurableObject(stub, async (relay) => {
      const bucket = relay.media;
      const counters = { gets: 0, getBytes: 0, puts: 0, heads: 0 };
      const observed = new Proxy(bucket, { get(target, name) {
        if (name === "get") return async (key: string, options?: R2GetOptions) => {
          counters.gets++;
          const object = await target.get(key, options);
          counters.getBytes += object?.size ?? 0;
          return object;
        };
        if (name === "put" || name === "head") return (...args: unknown[]) => {
          if (name === "put") counters.puts++; else counters.heads++;
          return Reflect.apply(target[name], target, args);
        };
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      Object.defineProperty(relay, "media", { value: observed, configurable: true });
      try {
        const response = await relay.fetch(new Request(`http://${host}${path}/git-receive-pack`, {
          method: "POST",
          headers: { "content-type": "application/x-git-receive-pack-request", "X-Git-Request-Id": requestId },
          body: concat(packet(`${"0".repeat(40)} ${next.commitID} ${ref}\0report-status\n`), flush(), next.pack),
        }));
        return { body: await response.text(), counters };
      } finally { Reflect.deleteProperty(relay, "media"); }
    });
    expect(retried.body).toContain(`ok ${ref}`);
    expect(retried.counters.puts).toBe(0);
    expect(retried.counters.gets).toBe(11);
    expect(retried.counters.getBytes).toBeLessThan(47_529);
    console.info("checkpoint old PR correction HTTP retry", JSON.stringify({ sequence, ...retried.counters }));
    await runInDurableObject(stub, async (relay) => {
      const wal = await gitRepository(relay, storedRepository(relay, pk(owner), "correction")!);
      expect((await wal.load()).sequence).toBe(sequence);
    });
    const visible = await SELF.fetch(`http://${host}${path}/info/refs?service=git-upload-pack`);
    const body = await visible.text();
    expect(body).toContain(`${next.commitID} ${ref}`);
    expect(body).toContain("symref=HEAD:refs/heads/main");
    // A new request must recheck authority even when its receipt is committed.
    await runInDurableObject(stub, (relay) => relay.settings.setEvent(pr.id, "hide"));
    const revoked = await receiveSettled(path, host, null, next.commitID, ref, next.pack, requestId);
    expect(await revoked.text()).toContain(`ng ${ref}`);
    await runInDurableObject(stub, async (relay) => {
      const wal = await gitRepository(relay, storedRepository(relay, pk(owner), "correction")!);
      expect((await wal.load()).sequence).toBe(sequence);
    });
  });

  it.each(["expired", "moderated"])("an identical Git retry completes interrupted promotion and rechecks %s candidates", async (mode) => {
    const host = `grasp-promotion-${mode}.bind.ws`;
    const owner = generateSecretKey();
    const pack = await tinyRepository();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "applypreset", "grasp");
    const announcement = repository(owner, host, "promotion");
    const state = ev(owner, KIND_REPO_STATE, "", [["d", "promotion"], ["HEAD", "ref: refs/heads/main"], ["refs/heads/main", pack.commitID]]);
    const c = await WS.connect(host);
    expect((await c.ok(announcement)).ok).toBe(true);
    expect((await c.ok(state)).ok).toBe(true);
    const pr = ev(owner, KIND_GIT_PR, "", [["a", `30617:${pk(owner)}:promotion`], ["c", pack.commitID]]);
    expect((await c.ok(pr)).ok).toBe(true);
    c.ws.close();
    const path = gitRepositoryPath(npubEncode(pk(owner)), "promotion");
    const requestId = "promotion-recovery";
    const stub = env.RELAY.getByName(`grasp-promotion-${mode}`);
    await runInDurableObject(stub, async (relay) => {
      const bucket = relay.media;
      let published = false;
      let failed = false;
      const observed = new Proxy(bucket, { get(target, name) {
        if (name === "get") return (key: string, options?: R2GetOptions) => {
          if (published && key.endsWith("/root.json")) { failed = true; throw new Error("publication succeeded before promotion read failed"); }
          return target.get(key, options);
        };
        if (name === "put") return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.put, target, args);
          if (String(args[0]).endsWith("/root.json") && result) published = true;
          return result;
        };
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      Object.defineProperty(relay, "media", { value: observed, configurable: true });
      try {
        const response = await relay.fetch(new Request(`http://${host}${path}/git-receive-pack`, {
          method: "POST",
          headers: { "content-type": "application/x-git-receive-pack-request", "X-Git-Request-Id": requestId },
          body: concat(packet(`${"0".repeat(40)} ${pack.commitID} refs/heads/main\0report-status\n`), flush(), pack.pack),
        }));
        expect(await response.text()).not.toContain("ok refs/heads/main");
        expect(published).toBe(true);
        expect(failed).toBe(true);
      } finally { Reflect.deleteProperty(relay, "media"); }
      const wal = await gitRepository(relay, storedRepository(relay, pk(owner), "promotion")!);
      expect((await wal.load()).sequence).toBe(1);
      expect(relay.sql.exec("SELECT id FROM grasp_pending WHERE id IN (?,?)", announcement.id, state.id).toArray()).toHaveLength(2);
    });
    const replay = await runInDurableObject(stub, async (relay) => {
      const bucket = relay.media;
      let roots = 0;
      const published: string[] = [];
      const broadcast = relay.broadcast.bind(relay);
      Object.defineProperty(relay, "broadcast", { configurable: true, value: (event: Parameters<typeof relay.broadcast>[0]) => {
        published.push(event.id);
        broadcast(event);
      } });
      const observed = new Proxy(bucket, { get(target, name) {
        if (name === "get") return (key: string, options?: R2GetOptions) => {
          // The replay loads the WAL, then promotion loads it again. Change
          // eligibility only after promotion's initial candidate check.
          if (key.endsWith("/root.json") && ++roots === 2) {
            if (mode === "expired") relay.sql.exec("UPDATE events SET expires=1 WHERE id=?", pr.id);
            else relay.settings.setEvent(pr.id, "hide");
          }
          return target.get(key, options);
        };
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      Object.defineProperty(relay, "media", { value: observed, configurable: true });
      try {
        const response = await relay.fetch(new Request(`http://${host}${path}/git-receive-pack`, {
          method: "POST",
          headers: { "content-type": "application/x-git-receive-pack-request", "X-Git-Request-Id": requestId },
          body: concat(packet(`${"0".repeat(40)} ${pack.commitID} refs/heads/main\0report-status\n`), flush(), pack.pack),
        }));
        expect(roots).toBeGreaterThanOrEqual(2);
        expect(published).toContain(announcement.id);
        expect(published).toContain(state.id);
        expect(published).not.toContain(pr.id);
        return await response.text();
      } finally {
        Reflect.deleteProperty(relay, "media");
        Reflect.deleteProperty(relay, "broadcast");
      }
    });
    expect(replay).toContain("ok refs/heads/main");
    await runInDurableObject(stub, async (relay) => {
      const wal = await gitRepository(relay, storedRepository(relay, pk(owner), "promotion")!);
      expect((await wal.load()).sequence).toBe(1);
      expect(relay.sql.exec("SELECT id FROM grasp_pending WHERE id IN (?,?)", announcement.id, state.id).toArray()).toEqual([]);
      // Expiry cleanup can remove the event and its pending row between
      // requests. If the event survives, it must still be held from readers.
      expect(relay.sql.exec("SELECT id FROM events WHERE id=? AND NOT EXISTS (SELECT 1 FROM grasp_pending WHERE grasp_pending.id=events.id)", pr.id).toArray()).toEqual([]);
    });
    const reader = await WS.connect(host);
    expect((await reader.query({ ids: [announcement.id, state.id] })).events).toHaveLength(2);
    reader.ws.close();
  });

  it("removes the public Git contract when reads become restricted", async () => {
    const host = "grasp-restricted.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { features: { grasp: true } });
    expect((await info(host)).supported_grasps).toEqual(["GRASP-01"]);
    await rpc(host, owner, "setpolicy", { reads: "members" });
    const document = await info(host);
    expect(document.supported_grasps).toBeUndefined();
    const response = await SELF.fetch(`http://${host}/npub1${"q".repeat(58)}/repo.git`);
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/^restricted:/);
  });

  it("fences event and management mutations while Git owns the authority view", async () => {
    const host = "grasp-fence.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { features: { grasp: true } });
    const event = repository(owner, host, "fenced");
    await runInDurableObject(env.RELAY.getByName("grasp-fence"), async (relay) => {
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const active = relay.repositoryAccess.run("git", async () => {
        entered();
        await hold;
      }, () => { throw new Error("Git scope unexpectedly refused"); });
      try {
        await ready;
        expect(relay.repositoryAccess.busy).toBe(true);
        expect(relay.repositoryAccess.kind).toBe("git");
        const result = await relay.acceptAny(event, relay.virtualConn(host, pk(owner)));
        expect(result.ok).toBe(false);
        expect(result.msg).toContain("relay operation in progress");
        const response = await relay.fetch(new Request(`http://${host}/`, { method: "POST", body: "{}" }));
        expect(response.status).toBe(429);
        await response.text();
        expect(relay.sql.exec("SELECT 1 FROM events WHERE id=?", event.id).toArray()).toEqual([]);
      } finally {
        release();
        await active;
        expect(relay.repositoryAccess.busy).toBe(false);
      }
    });
  });

  it("does not derive a PR update's repository from a moderated parent", async () => {
    const host = "grasp-parent.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { features: { grasp: true } });
    const c = await WS.connect(host);
    expect((await c.ok(repository(owner, host, "parent"))).ok).toBe(true);
    const parent = ev(owner, KIND_GIT_PR, "", [["a", `30617:${pk(owner)}:parent`], ["c", "a".repeat(40)]]);
    expect((await c.ok(parent)).ok).toBe(true);
    await runInDurableObject(env.RELAY.getByName("grasp-parent"), (relay) => relay.settings.setEvent(parent.id, "hide"));
    const update = ev(owner, KIND_GIT_PR_UPDATE, "", [["E", parent.id], ["c", "b".repeat(40)]]);
    const result = await c.ok(update);
    expect(result.ok).toBe(false);
    expect(result.msg).toContain("accepted repository");
    c.ws.close();
  });

});
