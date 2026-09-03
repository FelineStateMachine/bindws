// Who may do what. One table for both doors: the NIP-86 methods the console
// calls and the NIP-29 moderation events clients send. The owner may do
// everything; a moderator keeps the peace and nothing more.

export type Role = "owner" | "moderator" | "member";

export type Action =
  | "read" // stats, policy and the lists the console renders
  | "members" // add, edit and remove plain members
  | "ban"
  | "deleteEvent"
  | "invites"
  | "reports"
  | "rules" // access rules, kinds, retention
  | "identity" // name, description, icon
  | "storage"
  | "config" // export and import
  | "jobs" // pulls, backfills, rebroadcasts
  | "fork" // lease a new name and copy this relay into it
  | "transfer"
  | "deleteRelay";

const MODERATOR = new Set<Action>(["read", "members", "ban", "deleteEvent", "invites", "reports"]);

export function can(role: Role | null | undefined, action: Action): boolean {
  if (role === "owner") return true;
  if (role === "moderator") return MODERATOR.has(action);
  return false;
}

// The roles a relay advertises in its NIP-29 kind 39003.
export const ROLES: { role: Role; about: string }[] = [
  { role: "owner", about: "everything: rules, identity, people, storage, fuel" },
  { role: "moderator", about: "people, bans, deletions, invites, reports" },
];

// Every NIP-86 method and the action it needs. claim and supportedmethods
// are open and not listed.
export const METHOD_ACTIONS: Record<string, Action> = {
  stats: "read", getpolicy: "read", listpresets: "read",
  listbannedpubkeys: "read", listallowedpubkeys: "read", listmembers: "read", listpeople: "read", listinvites: "read",
  listbannedevents: "read", listrecentevents: "read", listallowedkinds: "read", listblockedkinds: "read", listblobs: "read", listretention: "read", listreports: "read",
  setmember: "members", allowpubkey: "members", removemember: "members", unrulepubkey: "members",
  banpubkey: "ban", banevent: "ban", allowevent: "ban", blockip: "ban", unblockip: "ban", listblockedips: "read", setblockedwords: "ban",
  deleteevent: "deleteEvent", pinevent: "deleteEvent", unpinevent: "deleteEvent", listpins: "read", searchevents: "read",
  createinvite: "invites", revokeinvite: "invites",
  resolvereport: "reports", listeventsneedingmoderation: "reports",
  setpolicy: "rules", allowkind: "rules", disallowkind: "rules", unrulekind: "rules", setretention: "rules", purgekind: "rules", resetrules: "rules", applypreset: "rules",
  changerelayname: "identity", changerelaydescription: "identity", changerelayicon: "identity",
  adddomain: "identity", removedomain: "identity", checkdomain: "identity", listdomains: "identity",
  storagestats: "storage", deleteblob: "storage", listdumps: "storage", deletedump: "storage", dumpnow: "storage",
  removesubtree: "members",
  exportconfig: "config", importconfig: "config",
  pullfrom: "jobs", pullstatus: "jobs", listjobs: "jobs", addjob: "jobs", removejob: "jobs", runjob: "jobs", backfill: "jobs",
  transferowner: "transfer", setsuccession: "transfer", clearsuccession: "transfer", successionstatus: "read",
  notifytest: "identity",
  forkrelay: "fork",
  deleterelay: "deleteRelay",
};
