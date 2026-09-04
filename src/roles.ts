// Who may do what. One permission table for both doors: the NIP-86 methods
// the console calls (each names its action in manage.ts) and the NIP-29
// moderation events clients send. The owner may do everything; a moderator
// keeps the peace and nothing more.

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
