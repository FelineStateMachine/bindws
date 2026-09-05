// Extension tests exercise public PR transport and bounded signed-state sync in workerd.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { createGitHandler, MemoryStore, NativeGitEngine, WalRepository, encodePack, readObjects } from "ntig";
import { ev, pk, rpc } from "../helpers/relay.ts";
import { KIND_REPO, KIND_REPO_STATE, KIND_GIT_PR } from "../../src/kinds.ts";
import { gitRepository, graspTick } from "../../src/grasp.ts";
import { repository, graspVisible } from "../../src/grasp-state.ts";
import { syncGitTick, gitSource } from "../../src/grasp-git-sync.ts";
import { nip11 } from "../../src/nip11.ts";
import type { Relay } from "../../src/relay.ts";

const enc = new TextEncoder();
const packet = (text: string) => { const bytes = enc.encode(text); return new Uint8Array([...enc.encode((bytes.length + 4).toString(16).padStart(4, "0")), ...bytes]); };
const join = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const post = async (relay: Relay, host: string, path: string, name: string, tip: string | null, pack?: Uint8Array, old: string | null = null, id = crypto.randomUUID()) => {
  const response = await relay.fetch(new Request(`https://${host}${path}/git-receive-pack`, { method: "POST", headers: { "content-type": "application/x-git-receive-pack-request", "x-git-request-id": id }, body: join(packet(`${old ?? "0".repeat(40)} ${tip ?? "0".repeat(40)} ${name}\0report-status\n`), enc.encode("0000"), ...(pack ? [pack] : [])) }));
  expect(response.status).toBe(200);
  return response.text();
};
const advertisement = async (relay: Relay, host: string, path: string) => (await relay.fetch(new Request(`https://${host}${path}/info/refs?service=git-upload-pack`))).text();
async function fixture() {
  const pack = await encodePack([{ type: "tree", data: new Uint8Array() }]);
  const tree = [...(await readObjects([pack])).keys()][0];
  const full = await encodePack([{ type: "tree", data: new Uint8Array() }, { type: "commit", data: enc.encode(`tree ${tree}\nauthor Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\ncommit\n`) }]);
  const tip = [...(await readObjects([full])).values()].find(o => o.type === "commit")!.oid;
  return { pack: full, tip };
}
const hosted = (owner: Uint8Array, host: string, identifier: string) => ev(owner, KIND_REPO, "", [["d", identifier], ["clone", `https://${host}/${npubEncode(pk(owner))}/${identifier}.git`, "https://source.example/repo.git"], ["relays", `wss://${host}`]]);

async function scope(name: string, action: (relay: Relay, owner: Uint8Array, host: string) => Promise<void>) {
  const owner = generateSecretKey(), host = `${name}.bind.ws`;
  await rpc(host, owner, "claim");
  await runInDurableObject(env.RELAY.getByName(name), async (relay, context) => {
    await context.storage.deleteAlarm();
    for (let i = 0; relay.repositoryAccess.busy && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await relay.repositoryAccess.run("alarm", async () => {
      relay.settings.update({ writes: "open", reads: "open", features: { ...relay.settings.policy.features, grasp: true, grasp02: false, grasp06: true } });
      try { await action(relay, owner, host); }
      finally {
        relay.settings.update({ features: { ...relay.settings.policy.features, grasp02: false, grasp06: false } });
        await context.storage.deleteAlarm();
      }
    }, () => { throw new Error("fixture did not acquire authority"); });
  });
}

describe("GRASP extension transport", () => {
  it.each(["event-first", "git-first"])("serves %s alternative PRs without target announcements", async order => {
    await scope(`grasp06-${order}`, async (relay, owner, host) => {
      const { pack, tip } = await fixture();
      const identifier = "with:colon";
      const path = `/prs/${npubEncode(pk(owner))}/with%3Acolon.git`;
      const e = ev(owner, KIND_GIT_PR, "", [["a", `30617:${"b".repeat(64)}:${identifier}`], ["clone", "https://foreign.example/repo.git", `https://${host}${path}`], ["c", tip]]);
      expect(await advertisement(relay, host, path)).toContain("capabilities^{}");
      expect(relay.sql.exec("SELECT * FROM grasp_objects").toArray()).toHaveLength(0);
      const accept = () => relay.accept(e, relay.virtualConn(host, pk(owner)));
      if (order === "event-first") expect(accept().ok).toBe(true);
      expect(await post(relay, host, path, `refs/nostr/${e.id}`, tip, pack)).toContain(`ok refs/nostr/${e.id}`);
      if (order === "git-first") { expect(accept().ok).toBe(true); await graspTick(relay); }
      expect(graspVisible(relay, e.id)).toBe(true);
      expect(await advertisement(relay, host, path)).toContain(tip);
      expect(await post(relay, host, path, `refs/nostr/${e.id}`, null, undefined, tip)).toContain(`ng refs/nostr/${e.id}`);
      expect(await post(relay, host, path, "refs/heads/main", tip, pack)).toContain("ng refs/heads/main");
      const ordinary = path.replace("/prs", "");
      expect((await relay.fetch(new Request(`https://${host}${ordinary}/info/refs?service=git-upload-pack`))).status).toBe(404);
    });
  });

  it("advertises only enabled validated profiles and closes every alternative endpoint with restricted reads", async () => {
    await scope("grasp06-private", async (relay, owner, host) => {
      expect(nip11(relay, host).supported_grasps).toEqual(["GRASP-01", "GRASP-06"]);
      relay.settings.update({ reads: "members" });
      expect(nip11(relay, host).supported_grasps).toBeUndefined();
      const path = `/prs/${npubEncode(pk(owner))}/repo.git`;
      for (const [suffix, method] of [["", "GET"], ["/info/refs?service=git-upload-pack", "GET"], ["/git-upload-pack", "POST"], ["/git-receive-pack", "POST"]]) {
        const r = await relay.fetch(new Request(`https://${host}${path}${suffix}`, { method }));
        expect(r.status).toBe(403);
      }
      expect(relay.sql.exec("SELECT * FROM grasp_objects").toArray()).toHaveLength(0);
    });
  });

  it("rejects wrong signer and foreign clone relationships without rejecting ordinary hosted PRs", async () => {
    await scope("grasp06-authority", async (relay, owner, host) => {
      const { tip } = await fixture();
      const other = generateSecretKey();
      const path = `/prs/${npubEncode(pk(owner))}/repo.git`;
      for (const clone of [`https://foreign.example${path}`, `https://${host}/prs/${npubEncode(pk(other))}/repo.git`]) {
        const e = ev(owner, KIND_GIT_PR, "", [["a", `30617:${pk(other)}:repo`], ["clone", clone], ["c", tip]]);
        expect(relay.accept(e, relay.virtualConn(host, pk(owner))).ok).toBe(false);
      }
      const repo = hosted(owner, host, "repo");
      expect(relay.accept(repo, relay.virtualConn(host, pk(owner))).ok).toBe(true);
      const pr = ev(other, KIND_GIT_PR, "", [["a", `30617:${pk(owner)}:repo`], ["c", tip]]);
      expect(relay.accept(pr, relay.virtualConn(host, pk(other))).ok).toBe(true);
    });
  });

  it("keeps unknown expiry fixed across retries and keeps deleted accepted PRs hidden", async () => {
    await scope("grasp06-expiry", async (relay, owner, host) => {
      const { pack, tip } = await fixture();
      const path = `/prs/${npubEncode(pk(owner))}/repo.git`, ref = `refs/nostr/${"a".repeat(64)}`;
      expect(await post(relay, host, path, ref, tip, pack, null, "same-upload")).toContain(`ok ${ref}`);
      relay.sql.exec("UPDATE grasp_pr_refs SET until=until-100 WHERE ref=?", ref);
      const deadline = relay.sql.exec<{ until: number }>("SELECT until FROM grasp_pr_refs WHERE ref=?", ref).one().until;
      expect(await post(relay, host, path, ref, tip, pack, null, "same-upload")).toContain(`ok ${ref}`);
      expect(relay.sql.exec<{ until: number }>("SELECT until FROM grasp_pr_refs WHERE ref=?", ref).one().until).toBe(deadline);
      relay.sql.exec("UPDATE grasp_pr_refs SET until=1 WHERE ref=?", ref);
      expect(await advertisement(relay, host, path)).not.toContain(tip);
      await graspTick(relay);
      expect(relay.sql.exec("SELECT * FROM grasp_pr_refs WHERE ref=?", ref).toArray()).toHaveLength(0);
      const e = ev(owner, KIND_GIT_PR, "", [["a", `30617:${pk(owner)}:repo`], ["clone", "https://foreign.example/repo.git", `https://${host}${path}`], ["c", tip]]);
      expect(relay.accept(e, relay.virtualConn(host, pk(owner))).ok).toBe(true);
      expect(await post(relay, host, path, `refs/nostr/${e.id}`, tip, pack)).toContain(`ok refs/nostr/${e.id}`);
      relay.sql.exec("DELETE FROM events WHERE id=?", e.id);
      expect(await advertisement(relay, host, path)).not.toContain(tip);
    });
  });

  it("reconciles signed state including deletions and skips network for locally available data", async () => {
    await scope("grasp02-state", async (relay, owner, host) => {
      const { pack, tip } = await fixture();
      const announcement = hosted(owner, host, "repo");
      expect(relay.accept(announcement, relay.virtualConn(host, pk(owner))).ok).toBe(true);
      const state = ev(owner, KIND_REPO_STATE, "", [["d", "repo"], ["HEAD", "ref: refs/heads/main"], ["refs/heads/main", tip]]);
      expect(relay.accept(state, relay.virtualConn(host, pk(owner))).ok).toBe(true);
      const source = new WalRepository(new MemoryStore(), new NativeGitEngine());
      await source.commit({ id: "seed", pack, updates: [{ name: "refs/heads/foreign-name", old: null, new: tip }] });
      const handler = createGitHandler(source);
      let requests = 0;
      relay.fetcher = async (url, init) => { requests++; return handler(new Request(url, init)); };
      relay.settings.update({ features: { ...relay.settings.policy.features, grasp02: true } });
      await syncGitTick(relay);
      const wal = await gitRepository(relay, repository(relay, pk(owner), "repo")!);
      expect((await wal.loadRefs()).refs).toEqual({ "refs/heads/main": tip });
      expect(requests).toBe(2);
      expect(graspVisible(relay, state.id)).toBe(true);
      const next = ev(owner, KIND_REPO_STATE, "", [["d", "repo"], ["HEAD", "ref: refs/heads/release"], ["refs/heads/release", tip]], state.created_at + 1);
      expect(relay.accept(next, relay.virtualConn(host, pk(owner))).ok).toBe(true);
      await syncGitTick(relay);
      expect((await wal.loadRefs()).refs).toEqual({ "refs/heads/release": tip });
      expect(requests).toBe(2);
      await syncGitTick(relay);
      expect(requests).toBe(2);
    });
  });

  it("imports accepted PR data into the target repository without requiring a local alternative clone URL", async () => {
    await scope("grasp02-pr", async (relay, owner, host) => {
      const { pack, tip } = await fixture();
      expect(relay.accept(hosted(owner, host, "repo"), relay.virtualConn(host, pk(owner))).ok).toBe(true);
      const contributor = generateSecretKey();
      const pr = ev(contributor, KIND_GIT_PR, "", [["a", `30617:${pk(owner)}:repo`], ["clone", `https://${host}/self.git`, "https://source.example/repo.git"], ["c", tip]]);
      expect(relay.accept(pr, relay.virtualConn(host, pk(contributor))).ok).toBe(true);
      const source = new WalRepository(new MemoryStore(), new NativeGitEngine());
      await source.commit({ id: "seed", pack, updates: [{ name: `refs/nostr/${pr.id}`, old: null, new: tip }] });
      const handler = createGitHandler(source);
      relay.fetcher = (url, init) => handler(new Request(url, init));
      relay.settings.update({ features: { ...relay.settings.policy.features, grasp02: true } });
      await syncGitTick(relay);
      const wal = await gitRepository(relay, repository(relay, pk(owner), "repo")!);
      expect((await wal.loadRefs()).refs[`refs/nostr/${pr.id}`]).toBe(tip);
      expect(graspVisible(relay, pr.id)).toBe(true);
    });
  });

  it("copies a locally hosted alternative PR into its target repository without self-fetching", async () => {
    await scope("grasp02-local-pr", async (relay, owner, host) => {
      const { pack, tip } = await fixture(), contributor = generateSecretKey();
      expect(relay.accept(hosted(owner, host, "repo"), relay.virtualConn(host, pk(owner))).ok).toBe(true);
      const path = `/prs/${npubEncode(pk(contributor))}/repo.git`;
      const pr = ev(contributor, KIND_GIT_PR, "", [["a", `30617:${pk(owner)}:repo`], ["clone", `https://${host}${path}`], ["c", tip]]);
      expect(relay.accept(pr, relay.virtualConn(host, pk(contributor))).ok).toBe(true);
      expect(await post(relay, host, path, `refs/nostr/${pr.id}`, tip, pack)).toContain(`ok refs/nostr/${pr.id}`);
      relay.fetcher = async () => { throw new Error("local PR must not use external fetch"); };
      relay.settings.update({ features: { ...relay.settings.policy.features, grasp02: true } });
      await syncGitTick(relay);
      const target = await gitRepository(relay, repository(relay, pk(owner), "repo")!);
      expect((await target.loadRefs()).refs).toEqual({ [`refs/nostr/${pr.id}`]: tip });
    });
  });

  it("rejects unsafe sources and backs failures off without busy retrying", async () => {
    await scope("grasp02-backoff", async (relay, owner, host) => {
      for (const url of ["https://127.0.0.1/repo.git", "https://169.254.169.254/repo.git", "https://localhost/repo.git", "https://private.internal/repo.git", `https://${host}/repo.git`, "https://user:pass@source.example/repo.git", "https://source.example:8443/repo.git"]) expect(gitSource(relay, url)).toBeNull();
      const { tip } = await fixture();
      expect(relay.accept(hosted(owner, host, "repo"), relay.virtualConn(host, pk(owner))).ok).toBe(true);
      expect(relay.accept(ev(owner, KIND_REPO_STATE, "", [["d", "repo"], ["refs/heads/main", tip]]), relay.virtualConn(host, pk(owner))).ok).toBe(true);
      let calls = 0;
      relay.fetcher = async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/" } }); };
      relay.settings.update({ features: { ...relay.settings.policy.features, grasp02: true } });
      const next = await syncGitTick(relay);
      expect(calls).toBe(1);
      expect(next).toBeGreaterThan(Math.floor(Date.now() / 1000));
      await syncGitTick(relay);
      expect(calls).toBe(1);
      expect((await (await gitRepository(relay, repository(relay, pk(owner), "repo")!)).loadRefs()).sequence).toBe(0);
    });
  });
});
