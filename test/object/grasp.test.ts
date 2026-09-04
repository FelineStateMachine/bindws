// The GRASP door: repository events name the service before Git answers, and
// pending authority stays out of ordinary relay reads until its data arrives.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { KIND_REPO, KIND_REPO_STATE, KIND_GIT_PR, KIND_GIT_PR_UPDATE } from "../../src/kinds.ts";
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
const receivePack = (path: string, host: string, old: string | null, next: string | null, ref: string, pack?: Uint8Array) => SELF.fetch(`http://${host}${path}/git-receive-pack`, {
  method: "POST",
  headers: { "content-type": "application/x-git-receive-pack-request" },
  body: concat(packet(`${old ?? "0".repeat(40)} ${next ?? "0".repeat(40)} ${ref}\0report-status\n`), flush(), ...(pack ? [pack] : [])),
});
const receiveSettled = async (path: string, host: string, old: string | null, next: string | null, ref: string, pack?: Uint8Array) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await receivePack(path, host, old, next, ref, pack);
    if (response.status !== 429) return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Git transaction did not become available");
};

async function tinyRepository() {
  const blob = encoder.encode("hello from grasp\n");
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

    expect((await receivePack(path, host, null, pack.commitID, "refs/heads/main", pack.pack)).status).toBe(200);
    const realPR = ev(owner, KIND_GIT_PR, "", [["a", `30617:${pk(owner)}:pr-refs`], ["c", pack.commitID]]);
    const unknownRef = `refs/nostr/${realPR.id}`;
    expect((await receivePack(path, host, null, pack.commitID, unknownRef, pack.pack)).status).toBe(200);
    expect(await (await SELF.fetch(`http://${host}${path}/info/refs?service=git-upload-pack`)).text()).toContain(`${pack.commitID} ${unknownRef}`);
    const deletion = await receiveSettled(path, host, pack.commitID, null, unknownRef);
    expect(deletion.status).toBe(200);
    expect(await deletion.text()).toContain(`ng ${unknownRef}`);

    const late = await WS.connect(host);
    expect((await late.ok(realPR)).ok).toBe(true);
    expect((await receivePack(path, host, pack.commitID, pack.commitID, "refs/heads/main")).status).toBe(200);
    expect((await late.req({ ids: [realPR.id] })).map((e) => e.id)).toEqual([realPR.id]);
    const listed = await SELF.fetch(`http://${host}${path}/info/refs?service=git-upload-pack`);
    expect(await listed.text()).toContain(`refs/nostr/${realPR.id}`);
    const wrongPR = ev(owner, KIND_GIT_PR, "", [["a", `30617:${pk(owner)}:pr-refs`], ["c", "b".repeat(40)]]);
    const wrongEvent = await WS.connect(host);
    expect((await wrongEvent.ok(wrongPR)).ok).toBe(true);
    const mismatch = await receivePack(path, host, null, pack.commitID, `refs/nostr/${wrongPR.id}`);
    expect(await mismatch.text()).toContain(`ng refs/nostr/${wrongPR.id}`);
    wrongEvent.ws.close();

    const expiringID = "c".repeat(64);
    const expiringRef = `refs/nostr/${expiringID}`;
    expect(await (await receivePack(path, host, null, pack.commitID, expiringRef, pack.pack)).text()).toContain(`ok ${expiringRef}`);
    await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), (relay) => {
      relay.sql.exec("UPDATE grasp_pr_refs SET until=0 WHERE repo=? AND ref=?", `30617:${pk(owner)}:pr-refs`, expiringRef);
    });
    await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), (relay) => relay.alarm());
    const afterExpiry = await SELF.fetch(`http://${host}${path}/info/refs?service=git-upload-pack`);
    expect(await afterExpiry.text()).not.toContain(expiringRef);
    late.ws.close();
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
      relay.graspBusy = true;
      try {
        const result = await relay.acceptAny(event, relay.virtualConn(host, pk(owner)));
        expect(result.ok).toBe(false);
        expect(result.msg).toContain("Git transaction in progress");
        const response = await relay.fetch(new Request(`http://${host}/`, { method: "POST", body: "{}" }));
        expect(response.status).toBe(429);
        await response.text();
        expect(relay.sql.exec("SELECT 1 FROM events WHERE id=?", event.id).toArray()).toEqual([]);
      } finally { relay.graspBusy = false; }
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
