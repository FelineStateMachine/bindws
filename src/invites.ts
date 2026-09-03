// Invite links: the owner mints a code, shares https://<relay>/invite/<code>,
// and the visitor joins with one NIP-98 signature. Claiming is deliberately
// open to non-members: that is the whole point of an invite.
import { bytesToHex } from "./negentropy.ts";
import { page, escapeHTML } from "./ui.ts";

export type Invite = {
  code: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  max_uses: number; // 0 = unlimited
  uses: number;
  note: string;
};

const DAY = 86400;

export function mintInvite(sql: SqlStorage, by: string, ttlSecs: number, maxUses: number, note: string, now: number): Invite {
  const code = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const ttl = Math.min(Math.max(ttlSecs || 3 * DAY, 60), 30 * DAY);
  const inv: Invite = { code, created_by: by, created_at: now, expires_at: now + ttl, max_uses: Math.max(0, Math.min(maxUses || 0, 10_000)), uses: 0, note: note.slice(0, 200) };
  sql.exec(`INSERT INTO invites(code,created_by,created_at,expires_at,max_uses,uses,note) VALUES(?,?,?,?,?,?,?)`, inv.code, inv.created_by, inv.created_at, inv.expires_at, inv.max_uses, 0, inv.note);
  return inv;
}

export function listInvites(sql: SqlStorage, now: number): Invite[] {
  sql.exec(`DELETE FROM invites WHERE expires_at < ?`, now - 30 * DAY);
  return sql.exec<Invite>(`SELECT * FROM invites ORDER BY created_at DESC LIMIT 200`).toArray();
}

export function revokeInvite(sql: SqlStorage, code: string): boolean {
  return sql.exec(`DELETE FROM invites WHERE code=?`, code).rowsWritten > 0;
}

export type ClaimResult = "ok" | "invite_invalid" | "invite_expired" | "invite_exhausted";

// checkInvite validates without consuming; claimInvite consumes one use.
export function checkInvite(sql: SqlStorage, code: string, now: number): ClaimResult {
  const inv = sql.exec<Invite>(`SELECT * FROM invites WHERE code=?`, code).toArray()[0];
  if (!inv) return "invite_invalid";
  if (inv.expires_at < now) return "invite_expired";
  if (inv.max_uses > 0 && inv.uses >= inv.max_uses) return "invite_exhausted";
  return "ok";
}

export function claimInvite(sql: SqlStorage, code: string, now: number): ClaimResult {
  const r = checkInvite(sql, code, now);
  if (r === "ok") sql.exec(`UPDATE invites SET uses=uses+1 WHERE code=?`, code);
  return r;
}

// invitePage is the join page. It signs the claim with a NIP-07 extension.
export function invitePage(relayName: string, host: string, code: string, status: ClaimResult, terms: string): string {
  const problem = { invite_invalid: "This invite link isn't valid.", invite_expired: "This invite has expired.", invite_exhausted: "This invite has been used up.", ok: "" }[status];
  const css = `
main { max-width: 44rem; padding-top: 12vh; }
h1 { font-size: clamp(3.4rem, 10vw, 5.6rem); }
.terms { white-space: pre-wrap; background: var(--butter); border: 2px solid var(--ink); border-radius: 14px; box-shadow: 4px 4px 0 var(--ink); padding: 1rem 1.1rem; margin: 1.2rem 0 1.5rem; max-height: 18rem; overflow: auto; font-size: 14.5px; }
.bad { color: var(--red); font-weight: 600; }
p.lead { margin-top: 1.2rem; }
`;
  const body = `<main>
  <h1>Join <em>${escapeHTML(relayName)}</em></h1>
  ${problem ? `<p class="lead bad">${problem}</p><p class="note">Ask whoever invited you for a fresh link.</p>` : `
  <p class="lead">You've been invited to a relay at <code class="pill">wss://${escapeHTML(host)}</code>. Joining takes one signature with your nostr extension; the relay then accepts your events and, if it's members-only, serves you its content.</p>
  ${terms ? `<h3>Before you join</h3><div class="terms">${escapeHTML(terms)}</div>` : ""}
  <p class="row"><button id="join" class="btn pri">Join with extension</button><span class="note" id="note"></span></p>
  <script>
  (() => {
    const btn = document.getElementById("join"), note = document.getElementById("note");
    const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    btn.onclick = async () => {
      if (!window.nostr) { note.textContent = "You need a nostr browser extension (Alby, nos2x, …) to sign."; return; }
      btn.disabled = true; note.textContent = "signing…";
      try {
        const url = location.origin + "/api/invites/claim";
        const body = JSON.stringify({ code: ${JSON.stringify(code)} });
        const ev = await window.nostr.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags: [["u", url], ["method", "POST"], ["payload", await sha(body)]] });
        const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Nostr " + btoa(JSON.stringify(ev)) }, body })).json();
        if (r.error) throw new Error(r.error);
        note.textContent = r.status === "already_member" ? "you're already a member" : "welcome!";
        setTimeout(() => location.href = "/", 900);
      } catch (e) { note.textContent = e.message; btn.disabled = false; }
    };
  })();
  </script>`}
  <footer class="pg"><p>a bind.ws relay</p><a href="https://github.com/FelineStateMachine/bindws">source</a></footer>
</main>`;
  return page("join " + relayName, body, css);
}
