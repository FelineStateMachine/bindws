// Presets: Haven's four relays as rule bundles, one click each. Haven runs
// outbox, inbox, private and chat as four relays behind one binary and one
// config file. Here names are cheap, so one name per role is the way to get
// the same split: lease or claim a name, pick its preset, wire it into the
// matching list. A preset sets writes, reads, the people directory, kind
// rules and keep-for rules together and leaves limits, identity, people and
// bans alone.
import { DEFAULT_POLICY, type Policy, type Settings } from "./settings.ts";
import { SEARCH_KINDS } from "./store.ts";

export interface Preset {
  name: string;
  title: string;
  about: string;
  writes: Policy["writes"];
  reads: Policy["reads"];
  directoryPublic: boolean;
  allow: number[];
  block: number[];
  retention: { kind: number | null; days: number }[];
  // A replica keeps itself in step with a source relay through a standing
  // pull of its kinds. "required" presets refuse to apply without one.
  source?: "required" | "optional";
  every?: number; // hours between pulls
}

// The kinds a search replica carries: what the full-text index covers,
// minus drafts, which have no business on a public replica.
const SEARCHABLE = [...SEARCH_KINDS].filter((k) => k !== 30024).sort((a, b) => a - b);

export const PRESETS: Preset[] = [
  {
    name: "default",
    title: "Default",
    about: "Anyone writes, anyone reads, every kind, kept forever. The rules a fresh claim starts with.",
    writes: DEFAULT_POLICY.writes,
    reads: DEFAULT_POLICY.reads,
    directoryPublic: DEFAULT_POLICY.directoryPublic,
    allow: [],
    block: [],
    retention: [],
  },
  {
    // Haven's outbox: the owner's public notes, readable by all, blasted
    // elsewhere. Private kinds are blocked so a misconfigured client cannot
    // park DMs on a public relay; everything else is fair game.
    name: "outbox",
    title: "Outbox",
    about: "Only you write, anyone reads. Your public notes and articles, kept forever. Private kinds are refused.",
    writes: "owner",
    reads: "open",
    directoryPublic: true,
    allow: [],
    block: [4, 1059],
    retention: [],
  },
  {
    // Haven's inbox: where people reach the owner, so anyone may write, but
    // only the kinds that mean "for you": notes and replies, reposts,
    // reactions, comments, highlights, reports, zap receipts, plus profiles
    // so the senders render. Haven also checks that the owner is tagged;
    // kind rules cannot, so a short keep-for rule bounds what spam costs.
    // The owner's own lists always land regardless of the allow list.
    name: "inbox",
    title: "Inbox",
    about: "Anyone writes notes, replies, reactions and zaps meant for you; anyone reads. Everything is kept 90 days.",
    writes: "open",
    reads: "open",
    directoryPublic: true,
    allow: [0, 1, 6, 7, 16, 1111, 1984, 9735, 9802],
    block: [],
    retention: [{ kind: null, days: 90 }],
  },
  {
    // Haven's private relay: drafts, ecash, app data, anything the owner
    // wants nowhere else. Only the owner writes and only members read, so
    // a second device or a trusted person can be let in without opening it.
    name: "private",
    title: "Private",
    about: "Only you write, only members read. Drafts, wallets and app data, every kind, kept forever.",
    writes: "owner",
    reads: "members",
    directoryPublic: false,
    allow: [],
    block: [],
    retention: [],
  },
  {
    // Haven's chat relay, adapted: this relay already has members and a
    // NIP-29 group, so chat is the members-only group. Members write, members
    // read, and the kinds are gift wraps for private messages, group chat
    // messages and threads, comments, reactions and profiles. Join, leave
    // and moderation events are not subject to kind rules.
    name: "chat",
    title: "Chat",
    about: "Members write, members read. Private messages and the group's chat, kept forever. The directory is hidden.",
    writes: "allowlist",
    reads: "members",
    directoryPublic: false,
    allow: [0, 7, 9, 11, 1059, 1111],
    block: [],
    retention: [],
  },
  // Kind-scoped names: cheap names plus standing pulls make single-purpose
  // relays and specialised replicas nearly free. One name per job.
  {
    // A Blossom-only name, alice-media: the files live here, the notes do
    // not. Members write, so their uploads pass the upload gate, but the
    // only events they may post are profiles and Blossom server lists, so
    // the name stays a media host and nothing else.
    name: "media",
    title: "Media",
    about: "A media host. Members upload files; the only events accepted are profiles and Blossom server lists. Anyone reads.",
    writes: "allowlist",
    reads: "open",
    directoryPublic: true,
    allow: [0, 10063],
    block: [],
    retention: [],
  },
  {
    // A search replica, alice-search: a standing pull of the searchable
    // kinds from a source relay every six hours, readable by all, written
    // only by the owner, so a client can point search at it without the
    // source relay ever being asked.
    name: "search",
    title: "Search replica",
    about: "A read-only copy of another relay's notes, threads, comments, highlights, articles and wiki pages, refreshed every six hours. Anyone reads.",
    writes: "owner",
    reads: "open",
    directoryPublic: true,
    allow: SEARCHABLE,
    block: [],
    retention: [],
    source: "required",
    every: 6,
  },
  {
    // An articles name: long-form only, with the profiles that render the
    // bylines. Pulls from a source when one is given, otherwise the owner
    // publishes here directly.
    name: "articles",
    title: "Articles",
    about: "Long-form articles and the profiles behind them, nothing else. Only you write, anyone reads. Give a source relay to mirror its articles daily.",
    writes: "owner",
    reads: "open",
    directoryPublic: true,
    allow: [0, 30023],
    block: [],
    retention: [],
    source: "optional",
    every: 24,
  },
  {
    // A private-message inbox, alice-dm: anyone may drop a gift wrap, only
    // members read them. Wraps carry no author, so an allow list of just
    // the wrap kind and profiles keeps everything else out.
    name: "dm",
    title: "DM inbox",
    about: "An inbox for private messages. Anyone drops gift wraps, only members read them. Nothing else is accepted.",
    writes: "open",
    reads: "members",
    directoryPublic: false,
    allow: [0, 1059],
    block: [],
    retention: [],
  },
];

export function findPreset(name: string): Preset | undefined {
  return PRESETS.find((p) => p.name === name);
}

// applyPreset replaces the access rules, kind rules and keep-for rules with
// the bundle. Returns "" or a reason.
export function applyPreset(s: Settings, name: string): string {
  const p = findPreset(name);
  if (!p) return "invalid: no preset named " + name;
  s.update({ writes: p.writes, reads: p.reads, directoryPublic: p.directoryPublic });
  for (const k of [...s.listKinds("allow"), ...s.listKinds("block")]) s.setKind(k, null);
  for (const k of p.allow) s.setKind(k, "allow");
  for (const k of p.block) s.setKind(k, "block");
  for (const r of s.listRetention()) s.setRetention(r.kind, 0);
  for (const r of p.retention) s.setRetention(r.kind, r.days);
  return "";
}
