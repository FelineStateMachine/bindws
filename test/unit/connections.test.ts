// The Connect fold's pure parts (connections.ts): a text's placeholders
// filled for a viewer, a library document read or refused, an owner's list
// read with warnings, and the library itself. The door and the settings
// behind it are test/object/connections.test.ts.
import { describe, it, expect } from "vitest";
import { CONNECTION_TEMPLATES, FORMAT, MAX_CONNECTIONS, fill, parseConnectionTemplate, parseConnections, type Values } from "../../src/connections.ts";

const values: Values = {
  relay: { url: "wss://club.bind.ws", host: "club.bind.ws", web: "https://club.bind.ws", name: "club", domain: "bind.ws", hex: "ab".repeat(32), npub: "npub1relay", nprofile: "nprofile1relay", naddr: "naddr1room" },
  owner: { hex: "cd".repeat(32), npub: "npub1owner", nprofile: "nprofile1owner" },
  user: null,
};

// A library document that every relay can fill in.
const good = {
  format: FORMAT,
  title: "Feed",
  about: "The relay as a feed.",
  app: "Jumble",
  where: "web",
  icon: "notes",
  links: [
    { label: "Open", href: "https://jumble.social/?r={relay:url|enc}" },
    { label: "Copy relay URL", copy: "{relay:url}" },
  ],
};

describe("fill", () => {
  it("resolves every source, percent-encodes with |enc, and reads inputs by name", () => {
    const r = fill("{relay:web}/p/{owner:npub}?r={relay:url|enc}&repo={input:repo}", values, { repo: "mine" });
    expect(r).toEqual({ text: "https://club.bind.ws/p/npub1owner?r=wss%3A%2F%2Fclub.bind.ws&repo=mine", missing: [] });
    expect(fill("plain text", values, {})).toEqual({ text: "plain text", missing: [] });
    expect(fill("{relay:naddr}", values, {}).text).toBe("naddr1room");
    expect(fill("{owner:hex|enc}", values, {}).text).toBe("cd".repeat(32));
  });

  it("lists what nobody is signed in for as user:npub and leaves the text without it", () => {
    expect(fill("nostr:{user:npub}", values, {})).toEqual({ text: "nostr:", missing: ["user:npub"] });
    const signed = { ...values, user: { hex: "ef".repeat(32), npub: "npub1viewer", nprofile: "nprofile1viewer" } };
    expect(fill("nostr:{user:npub}", signed, {})).toEqual({ text: "nostr:npub1viewer", missing: [] });
  });

  it("lists an empty owner, an unset input and an unknown field as missing rather than filling a blank", () => {
    const unclaimed = { ...values, owner: { hex: "", npub: "", nprofile: "" } };
    expect(fill("https://primal.net/p/{owner:nprofile}", unclaimed, {})).toEqual({ text: "https://primal.net/p/", missing: ["owner:nprofile"] });
    expect(fill("{relay:url}/{input:repo}.git", values, {}).missing).toEqual(["input:repo"]);
    expect(fill("{relay:url}/{input:repo}.git", values, { repo: "" }).missing).toEqual(["input:repo"]);
    expect(fill("{owner:npub} {user:hex}", unclaimed, {}).missing).toEqual(["owner:npub", "user:hex"]);
  });
});

describe("parseConnectionTemplate", () => {
  it("accepts a good document, defaults the visibility to public and the QR to the first href", () => {
    const t = parseConnectionTemplate("feed", good);
    expect(typeof t).toBe("object");
    if (typeof t === "string") return;
    expect(t.name).toBe("feed");
    expect(t.title).toBe("Feed");
    expect(t.visibility).toBe("public");
    expect(t.icon).toBe("notes");
    expect(t.feature).toBeUndefined();
    expect(t.inputs).toEqual([]);
    expect(t.links).toEqual(good.links);
    expect(t.qr).toBe("https://jumble.social/?r={relay:url|enc}");
  });

  it("takes the QR the document names, an icon default, a feature and declared inputs", () => {
    const t = parseConnectionTemplate("repos", { ...good, icon: undefined, feature: "grasp", visibility: "auth", qr: "nostr:{owner:nprofile}", inputs: [{ name: "repo", label: "Repository", placeholder: "name", default: "notes" }], links: [{ label: "Clone", copy: "{relay:web}/{user:npub}/{input:repo}.git" }] });
    expect(typeof t).toBe("object");
    if (typeof t === "string") return;
    expect(t.icon).toBe("app");
    expect(t.feature).toBe("grasp");
    expect(t.visibility).toBe("auth");
    expect(t.qr).toBe("nostr:{owner:nprofile}");
    expect(t.inputs).toEqual([{ name: "repo", label: "Repository", placeholder: "name", default: "notes" }]);
    expect(t.links).toEqual([{ label: "Clone", copy: "{relay:web}/{user:npub}/{input:repo}.git" }]);
  });

  it("refuses what is not a template, another format, and a document short of a title, an about or an app", () => {
    expect(parseConnectionTemplate("x", null)).toBe("not a connection template");
    expect(parseConnectionTemplate("x", [])).toBe("not a connection template");
    expect(parseConnectionTemplate("x", { ...good, format: "bind.ws/connection-template/2" })).toBe("format must be " + FORMAT);
    expect(parseConnectionTemplate("x", { ...good, about: " " })).toBe("needs a title, an about and an app");
  });

  it("refuses a link that is not https or nostr, so an owner cannot smuggle a scheme in", () => {
    const r = parseConnectionTemplate("x", { ...good, links: [{ label: "Run", href: "javascript:alert(1)" }] });
    expect(r).toMatch(/^link Run must be https:\/\/ or nostr:/);
    expect(parseConnectionTemplate("x", { ...good, links: [{ label: "Data", href: "data:text/html,hi" }] })).toMatch(/must be https/);
    // Plain http is for a resolved {relay:web} on a local host, not for a template.
    expect(parseConnectionTemplate("x", { ...good, links: [{ label: "Plain", href: "http://insecure.example/" }] })).toBe("link Plain must be https:// or nostr:");
    expect(parseConnectionTemplate("x", { ...good, links: [{ label: "Copy", copy: "javascript:alert(1)" }] })).not.toBeTypeOf("string");
  });

  it("refuses a placeholder the relay cannot fill and an input the document does not declare", () => {
    expect(parseConnectionTemplate("x", { ...good, links: [{ label: "Open", href: "https://a.example/{relay:nonsense}" }] })).toMatch(/^link Open names \{relay:nonsense\}, which is not one of relay:url/);
    expect(parseConnectionTemplate("x", { ...good, links: [{ label: "Open", href: "https://a.example/{input:x}" }] })).toBe("link Open names {input:x} but declares no such input");
    expect(parseConnectionTemplate("x", { ...good, qr: "nostr:{user:nonsense}" })).toMatch(/^qr names \{user:nonsense\}/);
    expect(parseConnectionTemplate("x", { ...good, inputs: [{ name: "repo", label: "Repository" }], links: [{ label: "Open", href: "https://a.example/{input:branch}" }] })).toBe("link Open names {input:branch} but declares no such input");
  });

  it("refuses a link with both an href and a copy text, with neither, without a label, and a list of none", () => {
    expect(parseConnectionTemplate("x", { ...good, links: [{ label: "Both", href: "https://a.example/", copy: "text" }] })).toBe("link Both needs an href or a copy text, not both");
    expect(parseConnectionTemplate("x", { ...good, links: [{ label: "Neither" }] })).toBe("link Neither needs an href or a copy text, not both");
    expect(parseConnectionTemplate("x", { ...good, links: [{ href: "https://a.example/" }] })).toBe("a link needs a label");
    expect(parseConnectionTemplate("x", { ...good, links: [] })).toMatch(/^links must be a list of 1 to/);
  });

  it("refuses an unknown icon, feature or visibility and a badly named input", () => {
    expect(parseConnectionTemplate("x", { ...good, icon: "rocket" })).toMatch(/^icon must be one of/);
    expect(parseConnectionTemplate("x", { ...good, feature: "teleport" })).toMatch(/^feature must be one of/);
    expect(parseConnectionTemplate("x", { ...good, visibility: "friends" })).toBe("visibility must be one of public, auth, members, owner");
    expect(parseConnectionTemplate("x", { ...good, inputs: [{ name: "Repo Name", label: "Repository" }] })).toBe("an input name is lowercase letters, digits, dash and underscore");
    expect(parseConnectionTemplate("x", { ...good, inputs: [{ name: "repo", label: "One" }, { name: "repo", label: "Two" }] })).toBe("input repo is declared twice");
  });
});

describe("parseConnections", () => {
  const withInput = CONNECTION_TEMPLATES.find((t) => t.inputs.length > 0);

  it("keeps the order given, fills the template's default visibility and trims the words", () => {
    const r = parseConnections([{ template: "group", visibility: "members", title: "  The room  ", about: " Where we talk. " }, { template: "notes" }]);
    expect(r).toEqual({ list: [{ template: "group", visibility: "members", title: "The room", about: "Where we talk." }, { template: "notes", visibility: "public" }], warnings: [] });
  });

  it("drops an unknown template with a warning and keeps the rest in order", () => {
    const r = parseConnections([{ template: "notes" }, { template: "nope" }, { template: "group" }, {}, null]);
    expect(typeof r).toBe("object");
    if (typeof r === "string") return;
    expect(r.list.map((c) => c.template)).toEqual(["notes", "group"]);
    expect(r.warnings).toEqual(["connections[1]: no connection template named nope", "connections[3]: no connection template named (none)", "connections[4]: no connection template named (none)"]);
  });

  it("keeps a bad visibility or an undeclared input as a warning, and the entry with the template's own values", () => {
    const r = parseConnections([{ template: "notes", visibility: "friends", inputs: { x: "y" } }, { template: "group", inputs: "repo" }]);
    expect(typeof r).toBe("object");
    if (typeof r === "string") return;
    expect(r.list).toEqual([{ template: "notes", visibility: "public" }, { template: "group", visibility: "public" }]);
    expect(r.warnings).toEqual(["connections[0].visibility: must be one of public, auth, members, owner", "connections[0].inputs.x: notes has no such input", "connections[1].inputs: must be an object of input name to value"]);
  });

  it.skipIf(!withInput)("trims an input's value, drops a blank one and warns about one that is not a string", () => {
    const t = withInput!;
    const name = t.inputs[0].name;
    const r = parseConnections([{ template: t.name, inputs: { [name]: "  mine  " } }, { template: t.name, inputs: { [name]: "   " } }, { template: t.name, inputs: { [name]: 7 } }]);
    expect(typeof r).toBe("object");
    if (typeof r === "string") return;
    expect(r.list[0].inputs).toEqual({ [name]: "mine" });
    expect(r.list[1].inputs).toBeUndefined();
    expect(r.list[2].inputs).toBeUndefined();
    expect(r.warnings).toEqual([`connections[2].inputs.${name}: must be a string`]);
  });

  it("caps the list at 24 with a warning naming the first entry past it", () => {
    const r = parseConnections(Array.from({ length: MAX_CONNECTIONS + 2 }, () => ({ template: "notes" })));
    expect(typeof r).toBe("object");
    if (typeof r === "string") return;
    expect(r.list.length).toBe(MAX_CONNECTIONS);
    expect(r.warnings).toEqual([`connections[${MAX_CONNECTIONS}]: at most ${MAX_CONNECTIONS} connections`]);
  });

  it("is the reason when the list is not one, under the label the caller gave", () => {
    expect(parseConnections({ template: "notes" })).toBe("invalid: connections must be a list");
    expect(parseConnections("notes", "shortcuts")).toBe("invalid: shortcuts must be a list");
    const r = parseConnections([{ template: "nope" }], "shortcuts");
    expect(typeof r === "string" ? [] : r.warnings).toEqual(["shortcuts[0]: no connection template named nope"]);
  });
});

describe("the library", () => {
  it("has notes, find-me and group, and every template has a unique name, an about and at least one link", () => {
    const names = CONNECTION_TEMPLATES.map((t) => t.name);
    expect(names).toContain("notes");
    expect(names).toContain("find-me");
    expect(names).toContain("group");
    expect(new Set(names).size).toBe(names.length);
    for (const t of CONNECTION_TEMPLATES) {
      expect(t.links.length, t.name).toBeGreaterThan(0);
      expect(t.about.length, t.name).toBeGreaterThan(0);
      expect(t.title.length, t.name).toBeGreaterThan(0);
      expect(t.app.length, t.name).toBeGreaterThan(0);
      for (const l of t.links) expect(Boolean(l.href) !== Boolean(l.copy), `${t.name}: ${l.label}`).toBe(true);
    }
  });
});
