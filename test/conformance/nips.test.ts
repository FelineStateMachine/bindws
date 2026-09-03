import { describe, it, expect, afterEach } from "vitest";
import { Client, newEvent, newKey, pub, now, rand, randHex, sleep, item, RELAY_URL, HTTP_URL } from "./helpers.ts";

const open: Client[] = [];
const connect = async () => {
  const c = await Client.connect();
  open.push(c);
  return c;
};
afterEach(() => open.splice(0).forEach((c) => c.close()));

describe("NIP-11", () => {
  it("serves the information document with limitations", async () => {
    const resp = await fetch(HTTP_URL, { headers: { Accept: "application/nostr+json" } });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/nostr+json");
    const doc: any = await resp.json();
    expect(typeof doc.name).toBe("string");
    for (const n of [1, 9, 11, 40, 42, 45, 50, 62, 67, 70, 77]) expect(doc.supported_nips).toContain(n);
    expect(doc.limitation.max_subid_length).toBeGreaterThanOrEqual(64);
    expect(typeof doc.limitation.max_limit).toBe("number");
  });
});

describe("NIP-45 COUNT", () => {
  it("counts across OR'd filters without double counting, and adds an hll sketch for tag filters", async () => {
    const sk = newKey();
    const c = await connect();
    const target = randHex();
    for (let i = 0; i < 3; i++) await c.publish(newEvent(sk, 1, "n", [["t", target]], now() - 10 + i));
    await c.publish(newEvent(sk, 7, "+", [["e", target]], now() - 5));

    c.send("COUNT", "n", { kinds: [1], authors: [pub(sk)] }, { kinds: [7], authors: [pub(sk)] });
    expect((await c.expect("COUNT"))[2].count).toBe(4);
    c.send("COUNT", "n", { kinds: [1], authors: [pub(sk)] }, { "#t": [target], authors: [pub(sk)] });
    expect((await c.expect("COUNT"))[2].count).toBe(3);

    c.send("COUNT", "r", { kinds: [7], "#e": [target] });
    const res = (await c.expect("COUNT"))[2];
    expect(res.count).toBe(1);
    expect(res.hll).toMatch(/^[0-9a-f]{512}$/);
    // Register: offset = nibble 32 of the target + 8; byte[offset] indexes,
    // zero run after it plus one is the value.
    const offset = parseInt(target[32], 16) + 8;
    const pk = pub(sk);
    const regIndex = parseInt(pk.substr(offset * 2, 2), 16);
    const rest = pk.slice((offset + 1) * 2);
    let zeros = 0;
    for (const ch of rest) {
      const n = parseInt(ch, 16);
      if (n === 0) {
        zeros += 4;
        continue;
      }
      zeros += Math.clz32(n) - 28;
      break;
    }
    expect(parseInt(res.hll.substr(regIndex * 2, 2), 16)).toBe(zeros + 1);
  });
});

describe("NIP-40 expiration", () => {
  it("refuses expired events, serves unexpired ones, and stops serving after expiry", async () => {
    const sk = newKey();
    const c = await connect();
    const dead = newEvent(sk, 1, "gone", [["expiration", String(now() - 1)]]);
    c.send("EVENT", dead);
    expect(await c.expectOK(dead.id, false)).toMatch(/expired/);
    const soon = newEvent(sk, 1, "soon", [["expiration", String(now() + 2)]]);
    await c.publish(soon);
    expect((await c.req({ ids: [soon.id] })).events.length).toBe(1);
    await sleep(2500);
    expect((await c.req({ ids: [soon.id] })).events.length).toBe(0);
    c.send("COUNT", "q", { ids: [soon.id] });
    expect((await c.expect("COUNT"))[2].count).toBe(0);
  });
});

describe("NIP-50 search", () => {
  it("matches words in content, case-insensitively, ignores extensions, is injection-safe, and matches live", async () => {
    const sk = newKey();
    const c = await connect();
    const w = rand();
    const texts = [`Purple ${w}elephants dance`, `${w}orange juice`, `the ${w}elephant in the room`];
    for (const [i, t] of texts.entries()) await c.publish(newEvent(sk, 1, t, [], now() - 10 + i));
    await c.publish(newEvent(sk, 4, `${w}elephant encrypted`, [["p", pub(sk)]], now() - 5));

    let r = await c.req({ search: `${w}elephant`, authors: [pub(sk)] });
    expect(r.events.map((e) => e.content)).toEqual([texts[2]]);
    r = await c.req({ search: `PURPLE include:spam dance ${w}elephants`, authors: [pub(sk)] });
    expect(r.events.map((e) => e.content)).toEqual([texts[0]]);
    r = await c.req({ search: `${w}juice OR NOT "`, authors: [pub(sk)] });
    expect(r.hints).toContain("finish");

    c.send("REQ", "live", { search: `${w}banana`, authors: [pub(sk)] });
    await c.drain();
    await c.publish(newEvent(sk, 1, `a ${w}Banana split`));
    await c.expect("EVENT");
  });
});

describe("NIP-62 vanish", () => {
  it("deletes everything from the pubkey up to the request, plus gift wraps to it, and blocks resurrection", async () => {
    const sk = newKey();
    const other = newKey();
    const c = await connect();
    const t0 = now() - 100;
    const note = newEvent(sk, 1, "regret", [], t0);
    const meta = newEvent(sk, 0, "{}", [], t0);
    const wrap = newEvent(other, 1059, "dm", [["p", pub(sk)]], t0);
    const keep = newEvent(other, 1, "unrelated", [], t0);
    for (const e of [note, meta, wrap, keep]) await c.publish(e);

    let v = newEvent(sk, 62, "", [["relay", "wss://other.example"]], t0 + 1);
    c.send("EVENT", v);
    await c.expectOK(v.id, false);
    expect((await c.req({ authors: [pub(sk)] })).events.length).toBe(2);

    v = newEvent(sk, 62, "bye", [["relay", RELAY_URL]], t0 + 1);
    await c.publish(v);
    expect((await c.req({ authors: [pub(sk)] })).events).toEqual([]);
    expect((await c.req({ ids: [keep.id] })).events.length).toBe(1);
    const rc = await connect();
    await rc.auth(sk);
    expect((await rc.req({ kinds: [1059], "#p": [pub(sk)] })).events).toEqual([]);

    c.send("EVENT", note);
    expect(await c.expectOK(note.id, false)).toMatch(/^blocked:/);
    await c.publish(newEvent(sk, 1, "fresh start", [], t0 + 2));

    v = newEvent(other, 62, "", [["relay", "ALL_RELAYS"]], t0 + 3);
    await c.publish(v);
    expect((await c.req({ authors: [pub(other)] })).events).toEqual([]);
  });
});

describe("NIP-77 negentropy", () => {
  it("reconciles a client set against the relay's, respecting visibility", async () => {
    const sk = newKey();
    const recipient = newKey();
    const c = await connect();
    const t0 = now() - 1000;
    const relayHas = [];
    for (let i = 0; i < 100; i++) relayHas.push(await (async () => {
      const e = newEvent(sk, 1, String(i), [], t0 + Math.floor(i / 3));
      await c.publish(e);
      return e;
    })());
    const local = [];
    for (let i = 0; i < 5; i++) local.push(newEvent(sk, 1, "local " + i, [], t0 + 10 + i));
    const wrap = newEvent(sk, 1059, "dm", [["p", pub(recipient)]], t0 + 5);
    await c.publish(wrap);

    const clientItems = [...relayHas.slice(0, 60), ...local].map(item);
    const { have, need } = await c.sync(clientItems, { kinds: [1], authors: [pub(sk)] });
    expect(have).toEqual(local.map((e) => e.id).sort());
    expect(need).toEqual(relayHas.slice(60).map((e) => e.id).sort());

    // Strangers never learn the gift wrap; the recipient does.
    let r = await c.sync(relayHas.map(item), { authors: [pub(sk)] });
    expect(r.need).toEqual([]);
    const rc = await connect();
    await rc.auth(recipient);
    r = await rc.sync(relayHas.map(item), { authors: [pub(sk)] });
    expect(r.need).toEqual([wrap.id]);

    // Error paths.
    c.send("NEG-MSG", "nope", "61");
    expect((await c.expect("NEG-ERR"))[2]).toMatch(/^closed:/);
    c.send("NEG-OPEN", "bad", {}, "zz");
    expect((await c.expect("NEG-ERR"))[2]).toMatch(/^invalid:/);
    const x = await connect();
    x.send("NEG-OPEN", "dm", { kinds: [1059] }, "61");
    expect((await x.expect("NEG-ERR"))[2]).toMatch(/^auth-required:/);
    x.send("NEG-OPEN", "v", { kinds: [1], authors: [pub(sk)] }, "62");
    expect((await x.expect("NEG-MSG"))[2]).toBe("61");
  });
});
