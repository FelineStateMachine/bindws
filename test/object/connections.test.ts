// The Connect fold's shortcuts (connections.ts): the door that resolves
// them for whoever asks, the management methods that keep the owner's
// list, and the list travelling with configurations and presets. The pure
// parts are test/unit/connections.test.ts. Templates past notes, find-me
// and group are picked by what they declare, so the library can grow
// without this file naming each one.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { npubEncode, nprofileEncode } from "nostr-tools/nip19";
import { CONNECTION_TEMPLATES, fill, type ConnectionTemplate, type Values } from "../../src/connections.ts";
import { DEFAULT_CONNECTIONS, type Feature } from "../../src/settings.ts";
import { PRESETS } from "../../src/presets.ts";
import { rpc, get, pk, nip98 } from "../helpers/relay.ts";

// connect reads the door, signed when a key is given, with the cache header along.
async function connect(host: string, sk: Uint8Array | null = null) {
  const r = await get(host, "/connect.json", sk);
  return { status: r.status, cache: r.headers.get("cache-control"), cors: r.headers.get("access-control-allow-origin"), ...(await r.json<any>()) };
}

// valuesOf is what the relay is expected to fill in, from its card and the
// keys, so a template's links can be resolved here and compared.
async function valuesOf(host: string, owner: Uint8Array | null, user: Uint8Array | null): Promise<Values> {
  const card: any = await (await get(host, "/card.json")).json();
  const url = `wss://${host}`;
  const self = card.self ?? "";
  const profile = (p: string) => (p ? nprofileEncode({ pubkey: p, relays: [url] }) : "");
  const npub = (p: string) => (p ? npubEncode(p) : "");
  const o = owner ? pk(owner) : "";
  const u = user ? pk(user) : "";
  return {
    relay: { url, host, web: `https://${host}`, name: host.split(".")[0], domain: "bind.ws", hex: self, npub: npub(self), nprofile: profile(self), naddr: card.naddr ?? "" },
    owner: { hex: o, npub: npub(o), nprofile: profile(o) },
    user: user ? { hex: u, npub: npub(u), nprofile: profile(u) } : null,
  };
}

// resolved is a template as the fold should show it: the links that fill
// in for these values, the inputs the owner set or the template's defaults.
function resolved(t: ConnectionTemplate, values: Values, inputs: Record<string, string> = {}) {
  const filled: Record<string, string> = {};
  for (const i of t.inputs) filled[i.name] = inputs[i.name] || i.default;
  const links: { label: string; href?: string; copy?: string }[] = [];
  let needsUser = false;
  for (const l of t.links) {
    const r = fill(l.href ?? l.copy ?? "", values, filled);
    if (r.missing.length) {
      if (r.missing.some((m) => m.startsWith("user:"))) needsUser = true;
      continue;
    }
    links.push(l.href ? { label: l.label, href: r.text } : { label: l.label, copy: r.text });
  }
  const qr = t.qr ? fill(t.qr, values, filled) : { text: "", missing: [] as string[] };
  return { links, needsUser, qr: qr.missing.length ? "" : qr.text };
}

const template = (name: string) => CONNECTION_TEMPLATES.find((t) => t.name === name)!;
const names = (answer: { connections: { template: string }[] }) => answer.connections.map((c) => c.template);
const text = (l: { href?: string; copy?: string }) => l.href ?? l.copy ?? "";
const namesUser = (l: { href?: string; copy?: string }) => text(l).includes("{user:");
// everyInput fills each of a template's inputs, so no link is left out for want of one.
const everyInput = (t: ConnectionTemplate) => Object.fromEntries(t.inputs.map((i) => [i.name, "mine"]));

// turnOn switches a template's feature on; the GRASP extensions need GRASP
// itself, and GRASP's own doors want open reads.
async function turnOn(host: string, owner: Uint8Array, f: Feature | undefined) {
  if (!f) return;
  const features: Record<string, boolean> = { [f]: true };
  if (f.startsWith("grasp0")) features.grasp = true;
  if (f === "grasp03" || f === "grasp05") features.grasp02 = true;
  expect((await rpc(host, owner, "setpolicy", { reads: "open", features })).status).toBe(200);
}

describe("connections", () => {
  it("answers a visitor with the defaults, every link filled in for this relay, cacheable for a minute", async () => {
    const host = "connect.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const card: any = await (await get(host, "/card.json")).json();
    expect(card.naddr).toBeDefined();
    expect(card.nprofile).toBeDefined();
    const values = await valuesOf(host, owner, null);
    const r = await connect(host);
    expect(r.status).toBe(200);
    expect(r.cache).toBe("public, max-age=60");
    expect(r.cors).toBe("*");
    expect(r.relay).toEqual({ url: "wss://connect.bind.ws", host, web: "https://connect.bind.ws", name: "connect" });
    expect(r.viewer).toBeNull();
    expect(names(r)).toEqual(DEFAULT_CONNECTIONS.map((c) => c.template));
    expect((await rpc(host, owner, "listconnections")).result).toEqual(DEFAULT_CONNECTIONS);
    for (const c of r.connections) {
      const t = template(c.template);
      const want = resolved(t, values);
      expect(c, c.template).toEqual({ template: t.name, title: t.title, about: t.about, app: t.app, where: t.where, icon: t.icon, visibility: "public", links: want.links, qr: want.qr, needsUser: false });
    }
    // The group address and the owner's profile are the card's, |enc
    // percent-encodes the relay URL, and no placeholder is left.
    const texts = r.connections.flatMap((c: any) => c.links.map(text));
    expect(texts.some((x: string) => x.includes(card.naddr))).toBe(true);
    expect(texts.some((x: string) => x.includes(card.nprofile))).toBe(true);
    expect(texts.some((x: string) => x.includes(encodeURIComponent("wss://" + host)))).toBe(true);
    // The fold has one relay URL copy control of its own, so no template carries the plain URL as a copy text.
    expect(r.connections.flatMap((c: any) => c.links.filter((l: any) => l.copy).map((l: any) => l.copy))).not.toContain("wss://" + host);
    for (const x of texts) expect(x).not.toMatch(/[{}]/);
    expect(r.connections.find((c: any) => c.template === "find-me").qr).toBe("nostr:" + card.nprofile);
    expect(r.connections.find((c: any) => c.template === "group").qr).toBe("nostr:" + card.naddr);
  });

  it("names a signed viewer, keeps that answer out of shared caches, and refuses a signature that does not fit", async () => {
    const host = "connect-signed.bind.ws";
    const owner = generateSecretKey();
    const viewer = generateSecretKey();
    await rpc(host, owner, "claim");
    const r = await connect(host, viewer);
    expect(r.status).toBe(200);
    expect(r.cache).toBe("no-store");
    expect(r.viewer).toBe(pk(viewer));
    expect(names(r)).toEqual(DEFAULT_CONNECTIONS.map((c) => c.template));
    const bad = await SELF.fetch(`http://${host}/connect.json`, { headers: { authorization: "Nostr nonsense" } });
    expect(bad.status).toBe(401);
    expect((await bad.json<any>()).error).toMatch(/^auth-required/);
    // A signature for another door does not count as a visitor either.
    const elsewhere = await SELF.fetch(`http://${host}/connect.json`, { headers: { authorization: await nip98(viewer, `http://${host}/card.json`) } });
    expect(elsewhere.status).toBe(401);
  });

  it("leaves out the owner's links on a relay nobody owns yet, and a shortcut with nothing else, without asking anyone to sign in", async () => {
    const host = "connect-nobody.bind.ws";
    const r = await connect(host);
    expect(r.status).toBe(200);
    expect(r.viewer).toBeNull();
    // Every link of find-me names the owner, so the whole shortcut waits for one.
    const t = template("find-me");
    expect(t.links.every((l) => text(l).includes("{owner:"))).toBe(true);
    expect(r.connections.find((x: any) => x.template === "find-me")).toBeUndefined();
    // Notes names only the relay, so it shows whole; the group shows what does not need an identity.
    const notes = r.connections.find((x: any) => x.template === "notes");
    expect(notes).toBeDefined();
    expect(notes.needsUser).toBe(false);
    expect(notes.links.map((l: any) => l.label)).toEqual(template("notes").links.map((l) => l.label));
    for (const x of r.connections) {
      expect(x.needsUser).toBe(false);
      for (const l of x.links) expect(text(l)).not.toMatch(/[{}]/);
    }
  });

  it("shows each shortcut to whom its visibility admits, with the owner's title and about in place of the template's", async () => {
    const host = "connect-who.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    const outsider = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(member), { name: "eve" });
    const list = [
      { template: "notes", visibility: "public", title: "Our feed", about: "What we post, as one feed." },
      { template: "notes", visibility: "auth", title: "Signed in" },
      { template: "group", visibility: "members", title: "Members" },
      { template: "find-me", visibility: "owner", title: "Owner" },
    ];
    const saved = await rpc(host, owner, "setconnections", list);
    expect(saved.status, JSON.stringify(saved)).toBe(200);
    expect(saved.result).toEqual(list);
    const titles = async (sk: Uint8Array | null) => (await connect(host, sk)).connections.map((c: any) => c.title);
    expect(await titles(null)).toEqual(["Our feed"]);
    expect(await titles(outsider)).toEqual(["Our feed", "Signed in"]);
    expect(await titles(member)).toEqual(["Our feed", "Signed in", "Members"]);
    expect(await titles(owner)).toEqual(["Our feed", "Signed in", "Members", "Owner"]);
    const mine = (await connect(host, owner)).connections;
    expect(mine[0].about).toBe("What we post, as one feed.");
    expect(mine[0].app).toBe(template("notes").app);
    expect(mine[0].icon).toBe(template("notes").icon);
    expect(mine[1].about).toBe(template("notes").about);
    expect(mine.map((c: any) => c.visibility)).toEqual(["public", "auth", "members", "owner"]);
  });

  it("shows the defaults until the owner saves a list, nothing after an empty one, and the saved order", async () => {
    const host = "connect-order.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    expect(names(await connect(host))).toEqual(["notes", "find-me", "group"]);
    let r = await rpc(host, owner, "setconnections", [{ template: "group" }, { template: "notes" }]);
    expect(r.status).toBe(200);
    expect(r.result).toEqual([{ template: "group", visibility: "public" }, { template: "notes", visibility: "public" }]);
    expect((await rpc(host, owner, "listconnections")).result).toEqual(r.result);
    expect(names(await connect(host))).toEqual(["group", "notes"]);
    r = await rpc(host, owner, "setconnections", []);
    expect(r.status).toBe(200);
    expect(r.result).toEqual([]);
    expect((await rpc(host, owner, "listconnections")).result).toEqual([]);
    expect((await connect(host)).connections).toEqual([]);
    expect((await rpc(host, owner, "exportconfig")).result.connections).toEqual([]);
  });

  it("refuses a list that does not fit, whole, to anyone but the owner, and logs the one it saved", async () => {
    const host = "connect-refuse.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(mod), { role: "moderator" });
    const before = (await rpc(host, owner, "listconnections")).result;
    let r = await rpc(host, owner, "setconnections", [{ template: "notes" }, { template: "nope" }]);
    expect(r.status).toBe(400);
    expect(r.error).toBe("invalid: connections[1]: no connection template named nope");
    r = await rpc(host, owner, "setconnections", [{ template: "notes", visibility: "friends" }]);
    expect(r.status).toBe(400);
    expect(r.error).toBe("invalid: connections[0].visibility: must be one of public, auth, members, owner");
    r = await rpc(host, owner, "setconnections", [{ template: "notes", inputs: { repo: "x" } }]);
    expect(r.status).toBe(400);
    expect(r.error).toBe("invalid: connections[0].inputs.repo: notes has no such input");
    r = await rpc(host, owner, "setconnections", [{ template: "repos", inputs: { repo: "kid's-project" } }]);
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/^invalid: connections\[0\]\.inputs\.repo: must match /);
    r = await rpc(host, owner, "setconnections", { template: "notes" });
    expect(r.status).toBe(400);
    expect(r.error).toBe("invalid: connections must be a list");
    expect((await rpc(host, owner, "setconnections")).status).toBe(400);
    expect((await rpc(host, mod, "setconnections", [])).status).toBe(403);
    expect((await rpc(host, null, "setconnections", [])).status).toBe(401);
    expect((await rpc(host, owner, "listconnections")).result).toEqual(before);
    expect((await rpc(host, mod, "listconnections")).status).toBe(200);
    expect((await rpc(host, mod, "listconnectiontemplates")).status).toBe(200);
    // The moderation log has the saved list and none of the refusals.
    const list = [{ template: "group", visibility: "members", title: "Room" }];
    expect((await rpc(host, owner, "setconnections", list)).status).toBe(200);
    const audit = (await rpc(host, owner, "listaudit")).result as { actor: string; action: string; detail: string }[];
    expect(audit[0].action).toBe("setconnections");
    expect(audit[0].actor).toBe(pk(owner));
    expect(JSON.parse(audit[0].detail)).toEqual(list);
    expect(audit.filter((row) => row.action === "setconnections").length).toBe(1);
  });

  const featured = CONNECTION_TEMPLATES.find((t) => t.feature);
  it.skipIf(!featured)("lists the library with whether each template's feature is on, and skips a shortcut whose feature is off", async () => {
    const host = "connect-feature.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const t = featured!;
    const f = t.feature!;
    expect((await rpc(host, owner, "setpolicy", { features: { [f]: false } })).status).toBe(200);
    let lib = (await rpc(host, owner, "listconnectiontemplates")).result as (ConnectionTemplate & { available: boolean })[];
    expect(lib.map((x) => x.name)).toEqual(CONNECTION_TEMPLATES.map((x) => x.name));
    expect(lib.find((x) => x.name === "notes")).toEqual({ ...template("notes"), available: true });
    expect(lib.find((x) => x.name === t.name)!.available).toBe(false);
    for (const x of lib) if (!x.feature) expect(x.available, x.name).toBe(true);
    expect((await rpc(host, owner, "setconnections", [{ template: t.name, visibility: "public", inputs: everyInput(t) }, { template: "notes" }])).status).toBe(200);
    expect(names(await connect(host, owner))).toEqual(["notes"]);
    await turnOn(host, owner, f);
    lib = (await rpc(host, owner, "listconnectiontemplates")).result;
    expect(lib.find((x) => x.name === t.name)!.available).toBe(true);
    expect(names(await connect(host, owner))).toEqual([t.name, "notes"]);
  });

  const personal = CONNECTION_TEMPLATES.find((t) => t.links.some((l) => text(l).includes("{user:npub")));
  it.skipIf(!personal)("fills {user:*} with whoever signed the request, and for a visitor leaves those links out and says so", async () => {
    const host = "connect-user.bind.ws";
    const owner = generateSecretKey();
    const viewer = generateSecretKey();
    await rpc(host, owner, "claim");
    const t = personal!;
    await turnOn(host, owner, t.feature);
    const inputs = everyInput(t);
    expect((await rpc(host, owner, "setconnections", [{ template: t.name, visibility: "public", inputs }])).status).toBe(200);
    const visitor = (await connect(host)).connections;
    expect(visitor.length).toBe(1);
    expect(visitor[0].needsUser).toBe(true);
    expect(visitor[0].links).toEqual(resolved(t, await valuesOf(host, owner, null), inputs).links);
    expect(visitor[0].links.map((l: any) => l.label)).toEqual(t.links.filter((l) => !namesUser(l)).map((l) => l.label));
    for (const l of visitor[0].links) expect(text(l)).not.toContain("{");
    // Signed in: the viewer's own key, not the owner's, and nothing missing.
    const mine = (await connect(host, viewer)).connections;
    expect(mine.length).toBe(1);
    expect(mine[0].needsUser).toBe(false);
    expect(mine[0].links).toEqual(resolved(t, await valuesOf(host, owner, viewer), inputs).links);
    expect(mine[0].links.map((l: any) => l.label)).toEqual(t.links.map((l) => l.label));
    const own = t.links.find((l) => text(l).includes("{user:npub"))!;
    const link = mine[0].links.find((l: any) => l.label === own.label)!;
    expect(text(link)).toContain(npubEncode(pk(viewer)));
    expect(text(link)).not.toContain(npubEncode(pk(owner)));
  });

  const withInput = CONNECTION_TEMPLATES.find((t) => t.inputs.length > 0);
  it.skipIf(!withInput)("puts the owner's input into the link, and the template's default when the input is blank", async () => {
    const host = "connect-input.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const t = withInput!;
    await turnOn(host, owner, t.feature);
    const i = t.inputs[0];
    const named = t.links.find((l) => new RegExp(`\\{input:${i.name}(\\|enc)?\\}`).test(text(l)))!;
    expect(named, `${t.name} has a link naming {input:${i.name}}`).toBeDefined();
    let r = await rpc(host, owner, "setconnections", [{ template: t.name, visibility: "public", inputs: { [i.name]: " rocket-7 " } }]);
    expect(r.status, JSON.stringify(r)).toBe(200);
    expect(r.result[0].inputs).toEqual({ [i.name]: "rocket-7" });
    let c = (await connect(host, owner)).connections[0];
    expect(c.template).toBe(t.name);
    expect(text(c.links.find((l: any) => l.label === named.label)!)).toContain("rocket-7");
    expect(c.links).toEqual(resolved(t, await valuesOf(host, owner, owner), { [i.name]: "rocket-7" }).links);
    // Blank: not kept, and the template's default fills the link.
    r = await rpc(host, owner, "setconnections", [{ template: t.name, visibility: "public", inputs: { [i.name]: "   " } }]);
    expect(r.status).toBe(200);
    expect(r.result[0].inputs).toBeUndefined();
    c = (await connect(host, owner)).connections[0];
    expect(c.links).toEqual(resolved(t, await valuesOf(host, owner, owner), {}).links);
    const fallback = c.links.find((l: any) => l.label === named.label);
    if (i.default) expect([i.default, encodeURIComponent(i.default)].some((d) => text(fallback!).includes(d))).toBe(true);
    else expect(fallback).toBeUndefined();
  });

  it("travels with the configuration: exported, planned as one summary line with warnings, applied, and left alone when the document has no section", async () => {
    const a = "connect-cfg-a.bind.ws", b = "connect-cfg-b.bind.ws";
    const owner = generateSecretKey();
    await rpc(a, owner, "claim");
    await rpc(b, owner, "claim");
    const mine = [{ template: "group", visibility: "members", title: "Room" }, { template: "notes", visibility: "public" }];
    expect((await rpc(a, owner, "setconnections", mine)).status).toBe(200);
    const cfg = (await rpc(a, owner, "exportconfig")).result;
    expect(cfg.connections).toEqual(mine);
    cfg.connections.push({ template: "nope" });
    let dry = (await rpc(b, owner, "importconfig", cfg, { dryRun: true })).result;
    expect(dry.warnings).toEqual(["connections[2]: no connection template named nope"]);
    expect(dry.changes.connections).toEqual({ add: [mine[0]], remove: [{ template: "find-me", visibility: "public" }, { template: "group", visibility: "public" }], reordered: false });
    expect(dry.changes.summary.filter((l: string) => l.startsWith("connections:"))).toEqual(["connections: +group (members), -find-me, -group"]);
    expect((await rpc(b, owner, "listconnections")).result).toEqual(DEFAULT_CONNECTIONS);
    expect((await rpc(b, owner, "importconfig", cfg)).status).toBe(200);
    expect((await rpc(b, owner, "listconnections")).result).toEqual(mine);
    expect(names(await connect(b, owner))).toEqual(["group", "notes"]);
    // No section: the list stays. The same list in another order is a reorder. An empty list clears it.
    delete cfg.connections;
    expect((await rpc(b, owner, "importconfig", cfg)).status).toBe(200);
    expect((await rpc(b, owner, "listconnections")).result).toEqual(mine);
    cfg.connections = [mine[1], mine[0]];
    dry = (await rpc(b, owner, "importconfig", cfg, { dryRun: true })).result;
    expect(dry.changes.connections).toEqual({ add: [], remove: [], reordered: true });
    expect(dry.changes.summary.filter((l: string) => l.startsWith("connections:"))).toEqual(["connections: reordered"]);
    expect((await rpc(b, owner, "importconfig", cfg)).status).toBe(200);
    expect((await rpc(b, owner, "listconnections")).result).toEqual([mine[1], mine[0]]);
    cfg.connections = [];
    dry = (await rpc(b, owner, "importconfig", cfg, { dryRun: true })).result;
    expect(dry.changes.summary.filter((l: string) => l.startsWith("connections:"))).toEqual(["connections: -notes, -group (members)"]);
    expect((await rpc(b, owner, "importconfig", cfg)).status).toBe(200);
    expect((await rpc(b, owner, "listconnections")).result).toEqual([]);
    expect((await rpc(b, owner, "importconfig", { format: cfg.format, connections: "notes" })).status).toBe(400);
  });

  it("is set by a preset that has a connections section and left alone by one that has not", async () => {
    const host = "connect-presets.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const mine = [{ template: "group", visibility: "members", title: "Room" }];
    expect((await rpc(host, owner, "setconnections", mine)).status).toBe(200);
    const plain = PRESETS.find((p) => !p.connections)!;
    expect(plain).toBeDefined();
    expect((await rpc(host, owner, "applypreset", plain.name, plain.source === "required" ? { source: "wss://elsewhere.bind.ws" } : undefined)).status).toBe(200);
    expect((await rpc(host, owner, "listconnections")).result).toEqual(mine);
    for (const p of PRESETS.filter((p) => p.connections)) {
      const r = await rpc(host, owner, "applypreset", p.name, p.source === "required" ? { source: "wss://elsewhere.bind.ws" } : undefined);
      expect(r.status, p.name + " " + JSON.stringify(r)).toBe(200);
      expect((await rpc(host, owner, "listconnections")).result, p.name).toEqual(p.connections);
      expect((await rpc(host, owner, "exportconfig")).result.connections, p.name).toEqual(p.connections);
    }
    const listed = (await rpc(host, owner, "listpresets")).result as { name: string; connections?: unknown }[];
    for (const x of listed) expect(x.connections, x.name).toEqual(PRESETS.find((p) => p.name === x.name)?.connections);
  });
});
