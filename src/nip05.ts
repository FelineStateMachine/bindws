// Every relay is a NIP-05 domain for its members: alice@<name>.bind.ws is
// the member whose name is "alice". Names live on the member record; members
// claim one by setting nip05 in their kind 0 profile, and the owner can assign
// or clear names from the console.
import type { Settings } from "./settings.ts";

// nip05Document answers /.well-known/nostr.json?name=<name>. A lookup by
// name answers for anyone: the member put that address in their own profile.
// Without a name the document is the directory, so it is empty unless the
// caller may list the members.
export function nip05Document(settings: Settings, name: string | null, relayURL: string, caller: string[] = []): Record<string, unknown> {
  const names: Record<string, string> = {};
  const relays: Record<string, string[]> = {};
  const rows = name === null ? (settings.mayList(caller) ? [] : settings.members().filter((m) => m.name)) : [settings.memberByName(name)].filter((m) => m !== null);
  for (const m of rows) {
    names[m!.name!] = m!.pubkey;
    relays[m!.pubkey] = [relayURL];
  }
  return { names, relays };
}

// claimFromProfile applies a member's kind 0 nip05 field when it names this relay.
export function claimFromProfile(settings: Settings, content: string, pubkey: string, host: string, now: number) {
  let nip05 = "";
  try {
    const j = JSON.parse(content) as { nip05?: unknown };
    if (typeof j.nip05 === "string") nip05 = j.nip05.trim().toLowerCase();
  } catch {
    return;
  }
  const at = nip05.lastIndexOf("@");
  if (at < 1) return;
  const [name, domain] = [nip05.slice(0, at), nip05.slice(at + 1)];
  if (domain !== host.toLowerCase().split(":")[0]) return;
  if (!settings.isAllowed(pubkey)) return;
  settings.upsertMember(pubkey, { name, via: "profile" }, now);
}
