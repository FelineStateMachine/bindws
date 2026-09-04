// The relay's own page. One document, no framework: the markup, styles and
// script are the three files in src/console, folded into src/gen/console.ts
// by npm run build:console.
//
// Front of house, for everyone: what this relay is, how to connect, who is
// here, fuel, and the NIP-11 reference behind a disclosure. The owner's
// console sits below as seven tabs, one per job: People, Moderation,
// Rules, Identity, Data, Health, Owner. Every action is a NIP-86 call signed with a NIP-07
// extension, so the page is a client of the same API scripts use.
//
// Subtext rule: a line of copy earns its place by warning or informing.
import { page } from "./ui.ts";
import { SIGNER_HASH } from "./gen/signer.ts";
import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_JS } from "./gen/console.ts";

// The NIP-46 client library is fetched only when someone picks a remote
// signer; the hash in its URL lets the long cache header be safe.
export function dashboard(): string {
  return page("relay", CONSOLE_HTML + '<script>window.SIGNER_URL = "/signer.js?v=' + SIGNER_HASH + '";</script><script>' + CONSOLE_JS + "</script>", CONSOLE_CSS);
}
