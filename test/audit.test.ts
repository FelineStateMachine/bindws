// The moderation log: every management method that changes something and
// every NIP-29 moderation event leaves a row that the owner and moderators
// can read back, newest first, with paging; reads leave nothing.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";

const now = () => Math.floor(Date.now() / 1000);
const ev = (sk: Uint8Array, kind: number, content: string, tags: string[][] = []) => finalizeEvent({ kind, content, tags, created_at: now() }, sk);
const pk = (sk: Uint8Array) => getPublicKey(sk);

async function rpc(host: string, sk: Uint8Array, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  return { status: resp.status, ...(await resp.json<any>()) };
}

async function publish(host: string, e: Event): Promise<{ ok: boolean; msg: string }> {
  const resp = await SELF.fetch(`http://${host}/`, { headers: { upgrade: "websocket" } });
  const ws = resp.webSocket!;
  ws.accept();
  return new Promise((res) => {
    ws.addEventListener("message", (m) => {
      const a = JSON.parse(m.data as string);
      if (a[0] === "OK") {
        ws.close();
        res({ ok: a[2], msg: a[3] });
      }
    });
    ws.send(JSON.stringify(["EVENT", e]));
  });
}

type Row = { seq: number; at: number; actor: string; action: string; target: string; detail: string };

describe("moderation log", () => {
  it("records what changed, who did it and to whom, and reads back newest first", async () => {
    const host = "auditlog.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    const member = generateSecretKey();
    const spammer = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(mod), { role: "moderator" });
    await rpc(host, owner, "setmember", pk(member), {});
    expect((await rpc(host, owner, "getpolicy")).status).toBe(200);
    expect((await rpc(host, mod, "banpubkey", pk(spammer), "spam")).status).toBe(200);
    expect((await rpc(host, owner, "blockip", "203.0.113.9", "swarm")).status).toBe(200);
    expect((await rpc(host, owner, "setblockedwords", ["casino"])).status).toBe(200);
    expect((await rpc(host, owner, "setpolicy", { reads: "auth", maxSubs: 5 })).status).toBe(200);
    // A refused call leaves nothing.
    expect((await rpc(host, mod, "setpolicy", { reads: "open" })).status).toBe(403);
    expect((await rpc(host, owner, "banpubkey", "zz", "")).status).toBe(400);

    const rows = (await rpc(host, owner, "listaudit")).result as Row[];
    const actions = rows.map((r) => [r.actor.slice(0, 8), r.action, r.target]);
    expect(actions.slice(0, 4)).toEqual([
      [pk(owner).slice(0, 8), "setpolicy", ""],
      [pk(owner).slice(0, 8), "setblockedwords", ""],
      [pk(owner).slice(0, 8), "blockip", "203.0.113.9"],
      [pk(mod).slice(0, 8), "banpubkey", pk(spammer)],
    ]);
    expect(rows[0].detail).toBe('["reads","maxSubs"]');
    expect(rows[1].detail).toBe('["casino"]');
    expect(rows[2].detail).toBe('"swarm"');
    expect(rows.map((r) => r.action)).not.toContain("getpolicy");
    expect(rows.map((r) => r.action)).toContain("setmember");
    for (const r of rows) expect(r.at).toBeGreaterThan(now() - 60);
    // seq descends; paging with `before` continues from a row.
    expect(rows[0].seq).toBeGreaterThan(rows[1].seq);
    const older = (await rpc(host, owner, "listaudit", rows[1].seq)).result as Row[];
    expect(older[0].seq).toBe(rows[2].seq);
    // Moderators read it, members do not, and reading is not itself logged.
    expect((await rpc(host, mod, "listaudit")).status).toBe(200);
    expect((await rpc(host, member, "listaudit")).status).toBe(403);
    expect(((await rpc(host, owner, "listaudit")).result as Row[])[0].action).toBe("setpolicy");
  });

  it("records NIP-29 moderation events under their names", async () => {
    const host = "auditgroup.bind.ws";
    const owner = generateSecretKey();
    const someone = generateSecretKey();
    await rpc(host, owner, "claim");
    const put = ev(owner, 9000, "", [["h", host.split(".")[0]], ["p", pk(someone), "member"]]);
    expect((await publish(host, put)).ok).toBe(true);
    const remove = ev(owner, 9001, "", [["h", host.split(".")[0]], ["p", pk(someone)]]);
    expect((await publish(host, remove)).ok).toBe(true);
    const rows = (await rpc(host, owner, "listaudit")).result as Row[];
    expect(rows.slice(0, 2).map((r) => [r.action, r.target, r.actor])).toEqual([
      ["remove-user", pk(someone), pk(owner)],
      ["put-user", pk(someone), pk(owner)],
    ]);
  });
});
