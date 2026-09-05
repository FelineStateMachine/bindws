(async () => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const host = location.host;
  const wsURL = (location.protocol === "https:" ? "wss://" : "ws://") + host;
  const rpcURL = location.origin + "/";
  let info = null, me = null, owner = "", policy = null, fuel = null, people = null, myRole = "";

  const toast = (msg) => { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2600); };
  // guard wraps a handler: disables the button, shows errors as toasts. Defined first, since handlers below use it.
  const guard = (fn) => async (ev) => { ev.preventDefault(); const b = ev.submitter || ev.target; if (b) b.disabled = true; try { await fn(ev); } catch (e) { toast(e.message); } finally { if (b) b.disabled = false; } };
  const short = (hex) => hex ? hex.slice(0, 8) + "…" + hex.slice(-4) : "";
  // key shows a key short but keeps the whole of it in the DOM: selecting, double-clicking or clicking it copies the full hex.
  const key = (hex) => hex ? '<span class="key" data-short="' + short(hex) + '" title="' + hex + '"><span class="full">' + hex + '</span></span>' : '';
  const hue = (hex) => (parseInt(hex.slice(0, 2), 16) * 360 / 256).toFixed(0) + "deg";
  const av = (hex) => '<i class="av" style="--h:' + hue(hex) + '"></i>';
  const fmtBytes = (n) => n < 1e6 ? (n / 1e3).toFixed(0) + " KB" : n < 1e9 ? (n / 1e6).toFixed(1) + " MB" : (n / 1e9).toFixed(2) + " GB";
  const fmtHours = (ms) => ms < 3600e3 ? Math.round(ms / 60e3) + " min" : (ms / 3600e3).toFixed(ms < 36e6 ? 1 : 0) + " h";
  const fuelOver = () => !!fuel && (fuel.eventBytes > fuel.freeEventBytes || fuel.mediaBytes > fuel.freeMediaBytes || fuel.activeMs > fuel.freeActiveMs || fuel.rowsWritten > fuel.freeRowsWritten);
  const fmtTime = (t) => t ? new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
  const fmtDay = (t) => t ? new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "–";
  const ago = (t) => { const s = Math.max(0, Math.floor(Date.now() / 1000) - t); return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + " min" : s < 86400 ? Math.floor(s / 3600) + " h" : Math.floor(s / 86400) + " d"; };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const IC = {
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M4 10h10a5 5 0 0 1 0 10h-3M4 10l4-4M4 10l4 4"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M6 7l1.2 13h9.6L18 7"/></svg>',
    ban: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></svg>',
    banuser: '<svg viewBox="0 0 24 24"><circle cx="10" cy="8" r="4"/><path d="M3 21a7 7 0 0 1 11-5.7M15 15l6 6M21 15l-6 6"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    lock: '<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
    pen: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4zM13 8l3 3"/></svg>',
    people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0M15 20a4.5 4.5 0 0 1 7-3.5"/></svg>',
    person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    gauge: '<svg viewBox="0 0 24 24"><path d="M4 16a8 8 0 0 1 16 0M12 16l4-5"/><circle cx="12" cy="16" r="1.2"/></svg>',
    bolt: '<svg viewBox="0 0 24 24"><path d="M13 3L5 14h6l-1 7 8-11h-6z"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 15v5"/></svg>',
  };
  const ib = (icon, label, act, id, extra) => '<button class="ib' + (extra ? " " + extra : "") + '" title="' + label + '" aria-label="' + label + '" data-act="' + act + '" data-id="' + esc(id) + '">' + IC[icon] + "</button>";

  const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  function npubToHex(s) {
    s = s.trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(s)) return s;
    if (!s.startsWith("npub1")) return null;
    const data = s.slice(5, -6).split("").map((c) => CH.indexOf(c));
    if (data.some((d) => d < 0)) return null;
    let bits = 0, acc = 0, out = [];
    for (const d of data) { acc = (acc << 5) | d; bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }
    return out.length === 32 ? out.map((b) => b.toString(16).padStart(2, "0")).join("") : null;
  }

  async function sha256hex(s) {
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  // ---- signing: a NIP-07 extension, or a NIP-46 remote signer ----
  // The remote path loads the bundled library on first use; its session
  // (client key, signer pubkey, relays) lives in localStorage until sign-out.
  let remote = null, lib = null, pendingNote = null;
  const NO_SIGNER = "Install a nostr extension (Alby, nos2x, …) or connect a remote signer.";
  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + " did not answer; is the signer app open?")), ms))]);
  const signer = {
    ready: () => !!remote || !!window.nostr,
    async getPublicKey() { if (remote) return withTimeout(remote.getPublicKey(), 20000, "The remote signer"); if (window.nostr) return window.nostr.getPublicKey(); throw new Error(NO_SIGNER); },
    async signEvent(ev) { if (remote) return withTimeout(remote.signEvent(ev), 60000, "The remote signer"); if (window.nostr) return window.nostr.signEvent(ev); throw new Error(NO_SIGNER); },
  };
  async function signerLib() {
    if (lib) return lib;
    if (!window.NostrSigner) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = window.SIGNER_URL || "/signer.js"; s.onload = res; s.onerror = () => rej(new Error("Could not load the signer library.")); document.head.appendChild(s); });
    return (lib = window.NostrSigner);
  }
  const onauth = (u) => window.open(u, "_blank");
  // The signer conversation rides this relay, and a relay may ask the socket to
  // authenticate before it delivers kind 24133 to its parties; answer with the
  // session's own key.
  const authPool = (L, sk) => new L.SimplePool({ automaticallyAuth: () => (evt) => Promise.resolve(L.finalizeEvent(evt, sk)) });
  const saveSession = (sk, s, secret) => localStorage.setItem("nip46", JSON.stringify({ sk: lib.bytesToHex(sk), pubkey: s.bp.pubkey, relays: s.bp.relays, secret: secret || null }));
  async function resumeRemote() {
    const raw = localStorage.getItem("nip46");
    if (!raw) return false;
    try {
      const s = JSON.parse(raw); const L = await signerLib();
      remote = L.BunkerSigner.fromBunker(L.hexToBytes(s.sk), { pubkey: s.pubkey, relays: s.relays, secret: s.secret }, { onauth, pool: authPool(L, L.hexToBytes(s.sk)) });
      return true;
    } catch { localStorage.removeItem("nip46"); return false; }
  }
  async function connectBunker(input) {
    const L = await signerLib();
    const bp = await L.parseBunkerInput(input.trim());
    if (!bp) throw new Error("That is not a bunker:// URL.");
    if (!bp.relays.length) throw new Error("The bunker URL names no relay.");
    const sk = L.generateSecretKey();
    const s = L.BunkerSigner.fromBunker(sk, bp, { onauth, pool: authPool(L, sk) });
    await withTimeout(s.connect({ name: host, url: location.origin }), 60000, "The signer");
    await Promise.race([s.switchRelays(), new Promise((r) => setTimeout(r, 3000))]);
    remote = s; saveSession(sk, s, bp.secret);
  }
  // The nostrconnect:// flow: this relay carries the traffic, so no third relay is involved.
  let ncPending = null;
  async function offerNostrConnect() {
    if (ncPending) return ncPending;
    const L = await signerLib();
    const sk = L.generateSecretKey();
    const secret = L.bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
    const uri = L.createNostrConnectURI({ clientPubkey: L.getPublicKey(sk), relays: [wsURL], secret, name: host, url: location.origin, perms: ["sign_event:27235", "sign_event:9734"] });
    $("#nclink").href = uri; $("#ncnote").textContent = "";
    $("#ncqr").src = "/qr.svg?text=" + encodeURIComponent(uri); $("#ncqr").classList.remove("hidden");
    ncPending = L.BunkerSigner.fromURI(sk, uri, { onauth, pool: authPool(L, sk) }, 600000).then((s) => { remote = s; saveSession(sk, s, secret); ncPending = null; return s; }, (e) => { ncPending = null; throw e; });
    return ncPending;
  }
  async function remoteDone() {
    me = await signer.getPublicKey();
    localStorage.setItem("me", me);
    $("#remotesec").classList.add("hidden");
    toast("Remote signer connected");
    if (pendingNote && !owner) { const n = pendingNote; pendingNote = null; await claimNow(n); return; }
    pendingNote = null;
    renderHeader(); await loadAdmin(); await loadPeople();
  }
  function showRemote(note) {
    pendingNote = note || null;
    $("#remotesec").classList.remove("hidden");
    $("#remotesec").scrollIntoView({ behavior: "smooth", block: "start" });
    offerNostrConnect().then(remoteDone).catch((e) => { $("#ncnote").textContent = e.message; });
  }

  async function rpc(method, ...params) {
    if (!signer.ready()) throw new Error(NO_SIGNER);
    const body = JSON.stringify({ method, params });
    const ev = await signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags: [["u", rpcURL], ["method", "POST"], ["payload", await sha256hex(body)]] });
    const resp = await fetch(rpcURL, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: "Nostr " + btoa(JSON.stringify(ev)) }, body });
    const json = await resp.json();
    if (json.error) throw new Error(json.error);
    return json.result;
  }

  // ---- front of house ----
  // urlish shows a URL as a short link: the host and the start of the path, the whole thing on hover and as the target.
  class Html { constructor(s) { this.s = s; } }
  const urlish = (u) => {
    if (!u) return "";
    let label = u; try { const x = new URL(u); label = x.host + (x.pathname.length > 1 ? x.pathname.slice(0, 18) + (x.pathname.length > 18 ? "\u2026" : "") : ""); } catch { /* not a URL */ }
    if (!/^https?:\/\//.test(u)) return u;
    return new Html('<a href="' + esc(u) + '" target="_blank" rel="noopener" title="' + esc(u) + '">' + esc(label) + "</a>");
  };
  function renderHeader() {
    const name = (info && info.name) || host.split(".")[0];
    $("#title").textContent = name;
    document.title = name + " - relay";
    $("#url").textContent = wsURL;
    $("#d-ws").textContent = wsURL; $("#d-blossom").textContent = location.origin; $("#d-nip05").textContent = "you@" + host;
    $("#nip05-example").textContent = "alice@" + host;
    const desc = (info && info.description) || "";
    $("#desc").textContent = desc; $("#desc").classList.toggle("hidden", !desc);
    // What the owner declared about the relay, on the page, not only in the document clients read.
    const img = (id, url) => { const el = $(id); if (url) el.src = url; el.classList.toggle("hidden", !url); };
    img("#bannerimg", info?.banner); $("#banner").classList.toggle("hidden", !info?.banner);
    img("#iconimg", info?.icon);
    const meta = [];
    for (const t of info?.tags || []) meta.push('<span class="tag">' + esc(t) + "</span>");
    const where = [...(info?.language_tags || []), ...(info?.relay_countries || [])];
    if (where.length) meta.push("<span>" + esc(where.join(", ")) + "</span>");
    const link = (label, href) => href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + label + "</a>" : "";
    const contact = info?.contact ? (/^(mailto:|https?:\/\/)/.test(info.contact) ? link("Contact", info.contact) : "<span>" + esc(info.contact) + "</span>") : "";
    for (const x of [contact, link("Terms", info?.terms_of_service), link("Posting policy", info?.posting_policy), link("Privacy", info?.privacy_policy)]) if (x) meta.push(x);
    $("#metarow").innerHTML = meta.join('<span class="sep">|</span>'); $("#metarow").classList.toggle("hidden", meta.length === 0);
    $("#frontsec").classList.toggle("hidden", !desc && meta.length === 0);
    owner = (info && info.pubkey) || "";
    const isOwner = !!me && me === owner;
    const lease = !owner && info && info.lease ? info.lease : null;
    $("#ownerline").innerHTML = owner ? 'run by <b>' + key(owner) + "</b>" : lease ? "temporary until " + fmtDay(lease.expires_at) : "unclaimed";
    $("#owner-av").classList.toggle("hidden", !owner);
    if (owner) $("#owner-av").style.setProperty("--h", hue(owner));
    $("#who").textContent = me ? (isOwner ? "(that's you)" : "") : "";
    $("#unclaimed").classList.toggle("hidden", !!owner || !!lease);
    $("#leased").classList.toggle("hidden", !lease);
    if (lease) {
      $("#lease-until").textContent = fmtTime(lease.expires_at);
      $("#leasenote").textContent = lease.holder ? "Reserved for the key that asked for it; sign with that key." : "";
    }
    $("#signin").classList.toggle("hidden", !!me || !owner);
    $("#signin46").classList.toggle("hidden", !!me || !owner);
    $("#signout").classList.toggle("hidden", !me);
    $("#about").innerHTML = [
      ["Name", info?.name], ["Description", info?.description], ["Contact", info?.contact], ["Owner", owner ? short(owner) : ""], ["Relay key", info?.self ? short(info.self) : ""], ["Software", urlish(info?.software)], ["Version", info?.version],
      ["Max query", info?.limitation?.max_limit], ["Auth required", String(!!info?.limitation?.auth_required)], ["Restricted writes", String(!!info?.limitation?.restricted_writes)], ["Min PoW", info?.limitation?.min_pow_difficulty || 0],
      ["Tags", info?.tags?.join(", ")], ["Languages", info?.language_tags?.join(", ")], ["Countries", info?.relay_countries?.join(", ")],
      ["Terms", urlish(info?.terms_of_service)], ["Posting policy", urlish(info?.posting_policy)], ["Privacy policy", urlish(info?.privacy_policy)], ["Icon", urlish(info?.icon)], ["Banner", urlish(info?.banner)],
      ["NIPs", info?.supported_nips?.join(" ")],
    ].map(([k, v]) => "<div><small>" + k + "</small><div" + (["Owner", "NIPs", "Relay key"].includes(k) ? ' class="mono"' : "") + ">" + (v === undefined || v === "" ? '<span class="muted">–</span>' : v instanceof Html ? v.s : esc(v)) + "</div></div>").join("");
    renderCare();
  }

  function renderCare() {
    const g = (icon, label, off) => '<span class="g' + (off ? " off" : "") + '" title="' + label + '"><i>' + IC[icon] + "</i><small>" + label + "</small></span>";
    const writes = policy ? policy.writes : (info?.limitation?.restricted_writes ? "allowlist" : "open");
    const reads = policy ? policy.reads : (info?.limitation?.auth_required ? "auth" : "open");
    let out = writes === "owner" ? g("person", "only owner writes") : writes === "allowlist" ? g("people", "members write") : writes === "wot" ? g("people", "members and follows write") : g("pen", "anyone writes");
    out += reads === "members" ? g("people", "members read") : reads === "auth" ? g("lock", "sign in to read") : g("eye", "anyone reads");
    if (fuel) {
      const over = fuelOver();
      out += fuel.outOfFuel ? g("gauge", "out of fuel", true) : over ? g("bolt", "burning sats") : g("gauge", "on free allowance");
    }
    $("#care").innerHTML = out;
  }

  async function loadPeople() {
    try { people = await (await fetch("/people")).json(); } catch { return; }
    const isOwner = !!me && me === owner;
    let list = people.people || [];
    if (!people.public && isOwner && policy) list = (window.__members || []);
    $("#peoplesec").classList.toggle("hidden", !owner || list.length === 0);
    $("#people-note").classList.toggle("hidden", people.public);
    $("#people-count").textContent = list.length || "";
    $("#dir").innerHTML = list.map((m) => '<span class="who' + (m.pubkey === me ? " me" : "") + '" title="' + esc(m.pubkey) + '">' + av(m.pubkey) + '<span class="mono">' + (m.name ? esc(m.name) + "@" + host : key(m.pubkey)) + "</span>" + (m.role === "owner" ? '<span class="role">owner</span>' : "") + "</span>").join("");
  }

  async function loadInfo() {
    info = await (await fetch("/", { headers: { accept: "application/nostr+json" } })).json();
    renderHeader();
    const git = info.supported_grasps?.includes("GRASP-01");
    $("#git-connect").classList.toggle("hidden", !git);
    const clone = "git clone '" + location.origin + "/<npub>/<repo>.git'";
    $("#git-clone").textContent = clone;
    $("#git-copy").dataset.copytext = clone;
    renderApps();
  }

  async function loadFuel() {
    try { fuel = await (await fetch("/fuel")).json(); } catch { return; }
    $("#fuelsec").classList.toggle("hidden", !owner);
    const pct = (used, free) => Math.min(100, Math.round((used / Math.max(free, 1)) * 100));
    const gauge = (id, used, free, text) => { const g = $("#g-" + id), share = free ? used / free : 0; g.style.width = pct(used, free) + "%"; g.classList.toggle("over", share > 1); g.classList.toggle("warm", share > 0.75 && share <= 1); $("#p-" + id).textContent = share > 1 ? "over" : Math.round(share * 100) + "%"; $("#t-" + id).textContent = text; };
    gauge("events", fuel.eventBytes, fuel.freeEventBytes, fmtBytes(fuel.eventBytes) + " of " + fmtBytes(fuel.freeEventBytes) + " free");
    gauge("media", fuel.mediaBytes, fuel.freeMediaBytes, fmtBytes(fuel.mediaBytes) + " of " + fmtBytes(fuel.freeMediaBytes) + " free");
    gauge("active", fuel.activeMs, fuel.freeActiveMs, fmtHours(fuel.activeMs) + " of " + fmtHours(fuel.freeActiveMs) + " free");
    gauge("rows", fuel.rowsWritten, fuel.freeRowsWritten, fuel.rowsWritten.toLocaleString() + " of " + fuel.freeRowsWritten.toLocaleString() + " free");
    const sats = Math.floor(fuel.balanceMsats / 1000);
    const r = fuel.rates;
    $("#fuel-balance").innerHTML = fuel.outOfFuel
      ? '<span class="chip">out of fuel</span> Writes are paused until someone tops up.'
      : "Balance <b>" + sats.toLocaleString() + " sats</b>. Past the allowances, prices track what the hosting costs: " + r.satsPerGBMonthEvents.toLocaleString() + " sats per GB-month of events, " + r.satsPerGBMonthMedia.toLocaleString() + " per GB-month of files, " + r.satsPerActiveHour.toLocaleString() + " per hour awake, " + r.satsPerMillionRows.toLocaleString() + " per million rows written. Traffic is free.";
    $("#topup").classList.toggle("hidden", !fuel.enabled);
    // Who paid is the owner's to see: it comes with the signed stats call.
    let credits = [];
    if (owner && signer.ready()) { try { credits = (await rpc("stats")).credits || []; } catch { credits = []; } }
    $("#credits tbody").innerHTML = credits.length ? credits.map((c) => '<tr><td class="dim">' + esc(fmtTime(c.at)) + '</td><td class="mono" title="' + esc(c.payer) + '">' + av(c.payer) + key(c.payer) + '</td><td class="mono r">' + Math.floor(c.msats / 1000).toLocaleString() + "</td></tr>").join("") : '<tr><td colspan="3" class="muted">no zaps yet</td></tr>';
    if (!fuel.enabled) $("#topup-note").textContent = "Top-ups are not enabled on this service yet.";
    renderCare();
    renderFuelTile();
  }

  async function topUp(sats) {
    if (!signer.ready()) throw new Error(NO_SIGNER);
    const msats = Math.round(sats * 1000);
    const zapRequest = await signer.signEvent({ kind: 9734, created_at: Math.floor(Date.now() / 1000), content: "fuel for " + host, tags: [["p", fuel.servicePubkey], ["amount", String(msats)], ["relays", wsURL]] });
    const r = await (await fetch("/fuel/invoice", { method: "POST", body: JSON.stringify({ zapRequest }) })).json();
    if (r.error) throw new Error(r.error);
    const inv = r.invoice;
    $("#invoice").classList.remove("hidden");
    $("#inv-text").value = inv; $("#inv-link").href = "lightning:" + inv; $("#inv-state").textContent = "waiting for payment…";
    if (window.webln) { try { await window.webln.enable(); await window.webln.sendPayment(inv); } catch (e) { toast(e.message || "wallet declined"); } }
    const before = fuel.creditedMsats;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      await loadFuel();
      if (fuel.creditedMsats > before) { $("#inv-state").textContent = "paid, thank you"; toast("Fuel credited"); return; }
    }
    $("#inv-state").textContent = "no receipt yet; it can take a minute after paying";
  }

  // ---- console ----
  function showTab(name) {
    if (name === "content" || name === "storage") name = "data";
    const known = myRole === "moderator" ? ["people", "moderation"] : ["people", "moderation", "rules", "identity", "data", "sync", "views", "health", "owner"];
    if (!known.includes(name)) name = "people";
    $$(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === name));
    $$(".panel").forEach((p) => p.classList.toggle("on", p.dataset.panel === name));
  }
  // Tabs switch in place. A fragment still opens a tab when someone arrives with one,
  // but clicking never writes one, and any fragment already there is dropped.
  $$(".tabs a").forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); showTab(a.dataset.tab); if (location.hash) history.replaceState(null, "", location.pathname + location.search); }));
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
  // The strip fades on whichever side has more tabs off screen.
  const tabsFade = () => { const t = $("#tabs"); t.classList.toggle("fade-l", t.scrollLeft > 4); t.classList.toggle("fade-r", t.scrollLeft + t.clientWidth < t.scrollWidth - 4); };
  $("#tabs").addEventListener("scroll", tabsFade); window.addEventListener("resize", tabsFade); new ResizeObserver(tabsFade).observe($("#tabs"));

  function renderFuelTile() {
    if (!fuel) return;
    const over = fuelOver();
    const sats = Math.max(0, Math.floor(fuel.balanceMsats / 1000));
    const d = new Date(), end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1), days = Math.max(1, Math.ceil((end - Date.now()) / 86400000));
    if (fuel.outOfFuel) { $("#h-fuel").textContent = "0 sats"; $("#h-fuel-label").textContent = "out of fuel"; $("#h-fuel-sub").textContent = "writes are paused"; }
    else if (over) { $("#h-fuel").textContent = sats.toLocaleString() + " sats"; $("#h-fuel-label").textContent = "fuel left"; $("#h-fuel-sub").textContent = "past the free allowance"; }
    else { $("#h-fuel").textContent = days + (days === 1 ? " day" : " days"); $("#h-fuel-label").textContent = "free allowance left"; $("#h-fuel-sub").textContent = sats ? "then " + sats.toLocaleString() + " sats" : "then a top-up is needed"; }
    $("#usage").innerHTML = [["events stored", fmtBytes(fuel.eventBytes)], ["files stored", fmtBytes(fuel.mediaBytes)], ["awake this month", fmtHours(fuel.activeMs)], ["rows written", fuel.rowsWritten.toLocaleString()], ["rows read", fuel.rowsRead.toLocaleString()], ["received this month", fmtBytes(fuel.bytesIn)], ["served this month", fmtBytes(fuel.bytesOut)], ["charged", Math.floor(fuel.chargedMsats / 1000).toLocaleString() + " sats"]]
      .map(([k, v]) => "<div><small>" + k + "</small><b>" + v + "</b></div>").join("");
  }

  function renderHealth(stats) {
    $("#h-last").textContent = stats.newest ? ago(stats.newest) : "none";
    $("#h-last-sub").textContent = stats.newest ? fmtTime(stats.newest) : "no events yet";
    $("#h-conns").textContent = stats.connections;
    const buckets = [["notes", "k1", [1]], ["reactions", "k2", [7]], ["DMs", "k3", [4, 14, 1059]], ["long-form", "k4", [30023]], ["other", "k5", null]];
    const sums = buckets.map(() => 0); let total = 0;
    for (const { kind, n } of stats.kinds || []) { total += n; const i = buckets.findIndex((b) => b[2] && b[2].includes(kind)); sums[i < 0 ? 4 : i] += n; }
    const parts = buckets.map((b, i) => [b[0], b[1], sums[i]]).filter((p) => p[2] > 0);
    $("#h-kinds").innerHTML = total ? parts.map(([name, cls, n]) => '<i class="' + cls + '" style="flex:' + n + '" title="' + name + " " + Math.round(n * 100 / total) + '%"></i>').join("") : '<i class="k5" style="flex:1"></i>';
    $("#h-kinds-legend").innerHTML = total ? parts.map(([name, cls, n]) => '<span><i class="' + cls + '"></i>' + name + " " + Math.round(n * 100 / total) + "%</span>").join("") : "<span>no events yet</span>";
    renderFuelTile();
  }

  async function loadAdmin() {
    const isOwner = !!me && me === owner;
    myRole = isOwner ? "owner" : "";
    let stats = null, p = null;
    // A signed-in member may be a moderator; the relay says by answering stats.
    if (me && owner && !isOwner) { try { [stats, p] = await Promise.all([rpc("stats"), rpc("getpolicy")]); myRole = "moderator"; } catch { myRole = ""; } }
    $("#console").classList.toggle("hidden", !myRole);
    loadMine();
    $("#console").classList.toggle("mod", myRole === "moderator");
    if (!myRole) { policy = null; renderCare(); return; }
    if (isOwner) [stats, p] = await Promise.all([rpc("stats"), rpc("getpolicy")]);
    policy = p;
    renderHealth(stats);
    renderCare();
    const fa = $("#access"), fi = $("#identity");
    fa.writes.value = p.writes; fa.reads.value = p.reads; fa.openKinds.value = (p.openKinds || []).join(", "); fa.guestReplies.checked = !!p.guestReplies;
    $("#wordsform").words.value = (p.blockedWords || []).join("\n"); $("#wordsform").inTags.checked = !!p.blockedWordsInTags; $("#thresholdform").reportThreshold.value = p.reportThreshold || 0; fa.minPow.value = p.minPow; fa.maxFuture.value = p.maxFuture; fa.maxLimit.value = p.maxLimit; fa.maxSubs.value = p.maxSubs; fa.maxMessageKB.value = p.maxMessageKB;
    fa.eventsPerMinute.value = p.eventsPerMinute; fa.reqsPerMinute.value = p.reqsPerMinute; fa.maxBlobMB.value = p.maxBlobMB;
    renderFeatures(p.features || {});
    $("#push-policy-form").elements.origins.value = (p.pushCallbacks || []).join("\n");
    $("#push-policy-form").elements.lettered.checked = !!p.letteredNips;
    $("#push-policy-form").elements.delivery.checked = !!p.delivery?.enabled;
    $("#push-policy-form").elements.deliveryMax.value = p.delivery?.maxTargets || 8;
    fi.name.value = p.name; fi.contact.value = p.contact; fi.description.value = p.description; fi.icon.value = p.icon;
    const fj = $("#joinform"); fj.joinTerms.value = p.joinTerms; fj.directoryPublic.checked = !!p.directoryPublic;
    loadCard();
    fi.banner.value = p.banner || ""; fi.postingPolicy.value = p.postingPolicy || ""; fi.privacyPolicy.value = p.privacyPolicy || "";
    fi.tags.value = (p.tags || []).join(", "); fi.languageTags.value = (p.languageTags || []).join(", "); fi.relayCountries.value = (p.relayCountries || []).join(", ");
    const fn = $("#notify"), nt = p.notify || {};
    fn.reports.checked = !!nt.reports; fn.fuel.checked = !!nt.fuel; fn.jobs.checked = !!nt.jobs; fn.succession.checked = !!nt.succession; fn.digest.checked = !!nt.digest;
    showTab(location.hash.slice(1));
    if (isOwner) { await renderPresets(); renderWire(); renderSuccession(); loadDomains(); }
    await Promise.all([loadLists(), loadEvents(true), loadPins(), ...(isOwner ? [loadStorage()] : [])]);
  }

  async function loadAudit(before) {
    const rows = await rpc("listaudit", before || 0);
    const html = rows.map((r) => '<tr data-seq="' + r.seq + '"><td class="dim">' + esc(fmtTime(r.at)) + '</td><td class="mono" title="' + esc(r.actor) + '">' + av(r.actor) + key(r.actor) + '</td><td><span class="kind">' + esc(r.action) + '</span></td><td class="mono">' + (/^[0-9a-f]{64}$/.test(r.target) ? key(r.target) : esc(r.target)) + '</td><td class="c">' + esc(r.detail) + '</td></tr>').join("");
    const tb = $("#audit tbody");
    if (before) tb.insertAdjacentHTML("beforeend", html); else tb.innerHTML = html || '<tr><td class="dim" colspan="5">Nothing yet</td></tr>';
    $("#audit-more").style.display = rows.length < 100 ? "none" : "";
  }
  $("#audit-more").onclick = guard(async () => { const last = $("#audit tbody tr:last-child"); await loadAudit(last ? +last.dataset.seq : 0); });
  async function loadLists() {
    loadAudit(0);
    const [mem, bans, bannedEvents, allow, block, invites, reports, blobs, blocks, sites] = await Promise.all([rpc("listmembers"), rpc("listbannedpubkeys"), rpc("listbannedevents"), rpc("listallowedkinds"), rpc("listblockedkinds"), rpc("listinvites"), rpc("listreports"), rpc("listblobs", 100), rpc("listblockedips"), rpc("listsites")]);
    const members = mem.members;
    window.__members = members;
    const roleCell = (m) => m.role === "owner" ? ' <span class="chip">owner</span>' : myRole === "owner" ? ' <select class="txt role" title="Role"><option value="member"' + (m.role === "member" ? " selected" : "") + '>member</option><option value="moderator"' + (m.role === "moderator" ? " selected" : "") + '>moderator</option></select>' : m.role === "moderator" ? ' <span class="chip">moderator</span>' : "";
    const untouchable = (m) => m.role === "owner" || (myRole !== "owner" && m.role === "moderator");
    // The tree: everyone under whoever invited them, the owner and the owner's own additions at the root.
    const known = new Set(members.map((m) => m.pubkey));
    const byInviter = new Map();
    for (const m of members) { const k = m.role !== "owner" && known.has(m.invited_by) ? m.invited_by : ""; if (!byInviter.has(k)) byInviter.set(k, []); byInviter.get(k).push(m); }
    const ordered = [], placed = new Set();
    const walk = (k, depth) => { for (const m of byInviter.get(k) || []) { if (placed.has(m.pubkey)) continue; placed.add(m.pubkey); m.depth = depth; ordered.push(m); walk(m.pubkey, depth + 1); } };
    walk("", 0);
    for (const m of members) if (!placed.has(m.pubkey)) { m.depth = 0; ordered.push(m); }
    const nameOf = (pk) => { const x = members.find((m) => m.pubkey === pk); return x && x.name ? x.name : short(pk); };
    const limits = (m) => m.role === "owner" ? "" : myRole === "owner"
      ? '<input class="txt num keep" type="number" min="0" placeholder="days" title="Keep this member\'s events for this many days; blank follows the relay rules" value="' + (m.keep_days || "") + '"><input class="txt num cap" type="number" min="0" placeholder="KB" title="Cap on stored bytes, in KB; blank is unlimited" value="' + (m.max_bytes ? Math.round(m.max_bytes / 1024) : "") + '">'
      : '<span class="dim">' + (m.keep_days ? m.keep_days + " d" : "") + (m.max_bytes ? " " + fmtBytes(m.max_bytes) : "") + "</span>";
    $("#members tbody").innerHTML = ordered.map((m) => '<tr data-pk="' + m.pubkey + '"><td class="mono" title="' + esc(m.pubkey) + '" style="padding-left:' + (0.5 + m.depth * 1.1) + 'rem">' + av(m.pubkey) + key(m.pubkey) + roleCell(m) + (m.depth ? ' <span class="dim">via ' + esc(nameOf(m.invited_by)) + "</span>" : "") + (m.invites ? ' <span class="chip" title="live invites">' + m.invites + " inv</span>" : "") + '</td><td class="name"><input class="txt name" value="' + esc(m.name || "") + '" placeholder="name" pattern="[a-z0-9._-]{1,64}"></td><td><input class="txt note" value="' + esc(m.note || "") + '" placeholder="note"></td><td class="lim">' + limits(m) + '</td><td class="dim">' + esc(fmtDay(m.joined_at)) + ", " + esc(m.via) + '</td><td class="r">' + ib("check", "Save", "savemember", m.pubkey) + (untouchable(m) ? "" : ib("x", "Remove", "removemember", m.pubkey) + ib("banuser", "Ban", "banpubkey", m.pubkey, "danger")) + "</td></tr>").join("");
    const tf = $("#treeform");
    tf.classList.toggle("hidden", myRole !== "owner");
    if (policy && policy.memberInvites) { tf.depth.value = policy.memberInvites.depth; tf.quota.value = policy.memberInvites.quota; }
    $("#transfer [name=pubkey]").innerHTML = members.filter((m) => m.role !== "owner").map((m) => '<option value="' + m.pubkey + '">' + esc(m.name ? m.name + "@" + host : key(m.pubkey)) + "</option>").join("");
    $("#succession [name=heir]").innerHTML = $("#transfer [name=pubkey]").innerHTML;
    $("#tc-people").textContent = members.length;
    const link = (code) => location.origin + "/invite/" + code;
    $("#invites").innerHTML = invites.length ? invites.map((i) => '<li><i class="ev">inv</i><span><a class="mono" href="/invite/' + i.code + '">…' + i.code.slice(-8) + "</a> " + esc(i.note || "") + ' <span class="dim">' + i.uses + (i.max_uses ? "/" + i.max_uses : "") + " used, until " + esc(fmtDay(i.expires_at)) + "</span></span><span>" + ib("copy", "Copy link", "copy", link(i.code)) + ib("x", "Revoke", "revokeinvite", i.code) + "</span></li>").join("") : '<li class="empty">no invites</li>';
    const person = (r, icon, label, act) => "<li>" + av(r.pubkey) + '<span><b class="mono" title="' + esc(r.pubkey) + '">' + short(r.pubkey) + "</b> " + esc(r.reason || "") + "</span>" + ib(icon, label, act, r.pubkey) + "</li>";
    $("#bans").innerHTML = bans.length ? bans.map((r) => person(r, "undo", "Unban", "unrulepubkey")).join("") : '<li class="empty">nobody banned</li>';
    $("#blocks").innerHTML = blocks.length ? blocks.map((r) => '<li><i class="ev">ip</i><span><b class="mono">' + esc(r.ip) + "</b> " + esc(r.reason || "") + "</span>" + ib("undo", "Unblock", "unblockip", r.ip) + "</li>").join("") : '<li class="empty">no addresses blocked</li>';
    $("#banned-events").innerHTML = bannedEvents.map((r) => '<li><i class="ev">ev</i><span><b class="mono" title="' + esc(r.id) + '">' + key(r.id) + "</b> " + esc(r.reason || "") + "</span>" + ib("check", "Allow again", "allowevent", r.id) + "</li>").join("");
    $("#reports tbody").innerHTML = reports.length ? reports.map((r) => '<tr><td class="dim">' + esc(fmtTime(r.at)) + '</td><td><span class="kind">' + esc(r.type || "report") + '</span></td><td class="mono" title="' + esc(r.target_pubkey) + '">' + av(r.target_pubkey) + key(r.target_pubkey) + (r.target_event ? (r.blob ? ' <a class="dim" href="/' + esc(r.target_event) + '" target="_blank" rel="noopener">file ' + key(r.target_event) + "</a>" : ' <span class="dim">ev ' + key(r.target_event) + (r.hidden ? ' <span class="tag">hidden</span>' : "") + "</span>") : "") + '</td><td class="c">' + esc(r.content) + '</td><td class="r">' + ib("check", "Dismiss", "resolve:dismiss", r.id) + ib("trash", r.blob ? "Delete the file" : "Delete the event", "resolve:delete", r.id) + ib("banuser", "Ban the author", "resolve:ban", r.id, "danger") + "</td></tr>").join("") : '<tr><td colspan="5" class="muted">nothing reported</td></tr>';
    $("#reports-count").textContent = reports.length || ""; $("#tc-reports").textContent = reports.length || "";
    $("#blobs tbody").innerHTML = blobs.length ? blobs.map((b) => '<tr><td class="dim">' + esc(fmtTime(b.uploaded)) + '</td><td class="mono"><a href="' + esc(b.url) + '" target="_blank" rel="noopener">' + key(b.sha256) + '</a> <span class="dim">' + esc(b.type) + '</span></td><td class="mono">' + fmtBytes(b.size) + '</td><td class="mono" title="' + esc(b.uploader) + '">' + av(b.uploader) + key(b.uploader) + '</td><td class="r">' + ib("trash", "Delete file", "deleteblob", b.sha256, "danger") + "</td></tr>").join("") : '<tr><td colspan="5" class="muted">no uploads</td></tr>';
    $("#blobs-count").textContent = blobs.length || "";
    $("#sites tbody").innerHTML = sites.length ? sites.map((s) => '<tr><td class="mono" title="' + esc(s.author) + '">' + av(s.author) + key(s.author) + '</td><td class="mono">' + esc(s.d || (s.kind === 5128 ? "snapshot" : "root")) + '</td><td><a href="' + esc(s.url) + '" target="_blank" rel="noopener" title="' + esc(s.url) + '">' + esc(s.url) + '</a></td><td class="r mono">' + esc(s.paths) + (s.missing ? ' <span class="chip bad" title="files still being mirrored">' + esc(s.missing) + ' missing</span>' : '') + '</td><td class="r mono">' + fmtBytes(s.size) + '</td><td class="dim">' + esc(s.expires_at ? fmtTime(s.expires_at) : "never") + '</td><td class="r">' + ib("trash", "Delete site", "deleteevent", s.id, "danger") + '</td></tr>').join("") : '<tr><td colspan="7" class="muted">no sites yet</td></tr>';
    $("#sites-count").textContent = sites.length || "";
    const tag = (k, cls) => '<span class="tag ' + cls + '">' + k + ib("x", "Remove rule", "unrulekind", String(k)) + "</span>";
    $("#kinds-allow").innerHTML = allow.length ? allow.map((k) => tag(k, "ok")).join("") : '<span class="tag plain">all</span>';
    $("#kinds-block").innerHTML = block.length ? block.map((k) => tag(k, "blk")).join("") : '<span class="tag plain">none</span>';
    await loadPeople();
  }

  const KIND_NAMES = { 0: "profiles", 1: "notes", 3: "contacts", 4: "DMs", 5: "deletions", 6: "reposts", 7: "reactions", 16: "reposts", 1059: "gift wraps", 1063: "file headers", 1111: "comments", 1984: "reports", 9734: "zap requests", 9735: "zap receipts", 9802: "highlights", 10002: "relay lists", 13534: "roster", 9000: "group adds", 9001: "group removals", 9021: "join requests", 9022: "leave requests", 39000: "group info", 39001: "group admins", 39002: "group members", 39003: "group roles", 30023: "articles", 30024: "drafts", 30078: "app data", 30311: "live events", 30818: "wiki" };
  const kindName = (k) => KIND_NAMES[k] || (k >= 20000 && k < 30000 ? "ephemeral" : k >= 30000 && k < 40000 ? "addressable" : k >= 10000 && k < 20000 ? "replaceable" : "kind " + k);
  const SYS_KINDS = new Set([0, 3, 10002, 9735, 13534, 8000, 8001, 9000, 9001, 39000, 39001, 39002, 39003]);
  let storage = null;

  // Features (settings.ts): a select each; search has three modes, the rest on or off.
  const FEATURES = [
    ["search", "Search", "NIP-50. Prose indexes notes, threads, comments, highlights, articles and wiki pages; full indexes every public kind with content. A change applies to events from then on.", ["prose:prose", "full:full", "off:off"]],
    ["sync", "Sync", "NIP-77 reconciliation, which reads the whole matching set per sync."],
    ["count", "Counts", "NIP-45 COUNT, with HLL sketches."],
    ["discovery", "Discovery record", "NIP-66: the record the relay signs about itself, for crawlers."],
    ["names", "Names", "NIP-05 addresses under this relay's domain."],
    ["files", "Files", "Blossom and NIP-96: uploads, downloads and listings."],
    ["pages", "Pages and feed", "Notes and articles as pages, and the Atom feed."],
    ["sites", "Static websites", "NIP-5A sites on their own hostnames. Mirroring copies missing files into this relay and costs fuel.", ["mirror:on, mirror files", "proxy:on, fetch as needed", "off:off"]],
    ["marmot", "Marmot transport", "Signed KeyPackages and encrypted group messages, with account admission for ephemeral authors."],
    ["grasp", "Git repositories", "GRASP Git hosting with admitted repository state. The prototype backend has bounded storage and compute limits."],
    ["push", "Relay push", "NIP-9a callback delivery for members and the owner. Requires approved callback origins; advertises lettered NIP identifiers."],
    ["signer", "Signer traffic", "NIP-46 remote signing carried for anyone, never stored."],
  ];
  function renderFeatures(f) {
    $("#features").innerHTML = FEATURES.map(([k, title, about, modes]) => {
      const cur = k === "sites" ? (f.sites?.enabled === false ? "off" : f.sites?.mirror === false ? "proxy" : "mirror") : modes ? String(f[k] || "prose") : String(f[k] !== false);
      const opts = (modes || ["true:on", "false:off"]).map((m) => { const [v, l] = m.split(":"); return '<option value="' + v + '"' + (cur === v ? " selected" : "") + ">" + l + "</option>"; }).join("");
      return "<label><span>" + esc(title) + " <small>" + esc(about) + "</small></span><select class=\"txt\" data-feature=\"" + k + "\">" + opts + "</select></label>";
    }).join("");
  }
  $("#features").addEventListener("change", guard(async (ev) => {
    const sel = ev.target.closest("select[data-feature]"); if (!sel) return;
    const k = sel.dataset.feature, v = k === "search" || k === "sites" ? sel.value : sel.value === "true";
    policy = await rpc("setpolicy", { features: { [k]: k === "sites" ? { enabled: v !== "off", mirror: v === "mirror" } : v } });
    toast(k === "search" ? "Search: " + v : (v ? "Switched on " : "Switched off ") + k); await loadInfo();
  }));

  $("#push-policy-form").addEventListener("submit", guard(async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const origins = form.elements.origins.value.split(/\s+/).filter(Boolean);
    const updated = await rpc("setpolicy", { pushCallbacks: origins, letteredNips: form.elements.lettered.checked, delivery: { enabled: form.elements.delivery.checked, maxTargets: Math.max(1, Math.min(16, Math.floor(+form.elements.deliveryMax.value || 8))) } });
    if (JSON.stringify(updated.pushCallbacks) !== JSON.stringify([...new Set(origins.map((s) => s.replace(/\/$/, "")))])) throw new Error("Use up to sixteen exact HTTPS origins, with no path or credentials.");
    policy = updated;
    toast("Saved delivery policy"); await loadInfo();
  }));

  async function loadViews() {
    let views;
    try { views = await rpc("listviews"); } catch { return; }
    $("#views").innerHTML = views.map((v) => {
      const runs = v.trigger === "off" ? "off" : v.trigger === "live" ? "live, from memory" : v.trigger === "write" ? "on write and daily" : v.trigger;
      const label = (c) => (c === "off" ? "off" : c === "write" ? "on write" : c === "live" ? "on" : c);
      const choices = [...v.choices, v.default].filter((c, i, a) => a.indexOf(c) === i);
      const pick = '<select class="txt" data-view="' + esc(v.name) + '" style="width:auto">' + choices.map((c) => '<option value="' + c + '"' + (c === v.trigger ? " selected" : "") + ">" + label(c) + "</option>").join("") + "</select>";
      const who = v.audience === "members" ? "members" + (v.stored ? "" : ", on request") : "anyone";
      const last = v.trigger === "live" ? "" : v.last ? "last run " + fmtTime(v.last.at) : "not run yet";
      const rows = v.trigger === "live" ? "no rows" : v.last ? v.last.rows.toLocaleString() + " rows" : "";
      const meta = [runs, who, last, rows].filter(Boolean).map((x) => "<span>" + esc(x) + "</span>").join('<span class="sep">|</span>');
      return '<div class="wire-row' + (v.on ? "" : " dim") + '"><div class="wire-main"><b>' + esc(v.name) + '</b><br><small>' + esc(v.about) + '</small></div><div class="wire-side"><div class="wire-acts">' + pick + (v.on ? '<a class="btn" href="' + esc(v.path) + '" target="_blank" rel="noopener">Open</a>' : "") + '</div><div class="wire-meta">' + meta + "</div></div></div>";
    }).join("");
  }
  $("#views").addEventListener("change", guard(async (ev) => {
    const sel = ev.target.closest("select[data-view]"); if (!sel) return;
    const value = sel.value === "live" ? true : sel.value;
    await rpc("setpolicy", { views: { [sel.dataset.view]: value } });
    toast(sel.value === "off" ? "Took down " + sel.dataset.view : sel.dataset.view + ": " + (sel.value === "live" ? "on" : sel.value === "write" ? "on write" : sel.value)); await loadViews(); await loadInfo();
  }));
  async function loadDumps() {
    const list = await rpc("listdumps");
    const f = $("#dumpform");
    if (policy) { f.dumps.value = policy.dumps || "off"; f.keep.value = policy.dumpsKeep || 7; }
    $("#dumps-count").textContent = list.length || "";
    $("#dumps").innerHTML = list.length ? list.map((d) => '<li><i class="ev">jsonl</i><span><b class="mono">' + esc(d.name) + '</b> <span class="dim">' + d.events.toLocaleString() + " events, " + fmtBytes(d.bytes) + "</span></span><span>" + ib("copy", "Download", "downloaddump", d.name) + ib("trash", "Delete", "deletedump", d.name, "danger") + "</span></li>").join("") : '<li class="empty">no dumps yet</li>';
  }
  // A dump is fetched with a signed request and handed to the browser as a file.
  async function downloadDump(name) {
    if (!signer.ready()) throw new Error(NO_SIGNER);
    const url = location.origin + "/dumps/" + name;
    const ev = await signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags: [["u", url], ["method", "GET"]] });
    const resp = await fetch(url, { headers: { authorization: "Nostr " + btoa(JSON.stringify(ev)) } });
    if (!resp.ok) throw new Error((await resp.json()).error || "download failed");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await resp.blob()); a.download = host.split(".")[0] + "-" + name; a.click(); URL.revokeObjectURL(a.href);
  }
  // A plain member's own invites, when the owner lets members invite.
  async function loadMine() {
    const sec = $("#myinvites");
    if (!me || !owner || myRole || !signer.ready()) { sec.classList.add("hidden"); return; }
    let mine;
    try { mine = await rpc("listinvites"); } catch { sec.classList.add("hidden"); return; }
    sec.classList.remove("hidden");
    const link = (code) => location.origin + "/invite/" + code;
    $("#mine").innerHTML = mine.length ? mine.map((i) => '<li><i class="ev">inv</i><span><a class="mono" href="/invite/' + i.code + '">…' + i.code.slice(-8) + '</a> <span class="dim">' + i.uses + (i.max_uses ? "/" + i.max_uses : "") + " used, until " + esc(fmtDay(i.expires_at)) + "</span></span><span>" + ib("copy", "Copy link", "copy", link(i.code)) + ib("x", "Revoke", "revokeinvite", i.code) + "</span></li>").join("") : '<li class="empty">no invites yet</li>';
  }
  async function loadStorage() {
    storage = await rpc("storagestats");
    pollJobs();
    loadViews();
    loadDumps().catch(() => {});
    const st = storage;
    const top = st.kinds.slice(0, 4), rest = st.kinds.slice(4).reduce((a, k) => a + k.bytes, 0);
    const parts = [...top.map((k, i) => [k.kind + " " + kindName(k.kind), "k" + (i + 1), k.bytes]), ...(rest ? [["other", "k5", rest]] : [])];
    const total = st.eventBytes || 1;
    $("#s-bar").innerHTML = parts.length ? parts.map(([n, c, b]) => '<i class="' + c + '" style="flex:' + b + '" title="' + esc(n) + " " + fmtBytes(b) + '"></i>').join("") : '<i class="k5" style="flex:1"></i>';
    $("#s-legend").innerHTML = parts.length ? parts.map(([n, c, b]) => '<span><i class="' + c + '"></i>' + esc(n) + " " + Math.round(b * 100 / total) + "%</span>").join("") : "<span>no events yet</span>";
    const overhead = Math.max(0, st.databaseBytes - st.eventBytes);
    $("#s-totals").innerHTML = [["events", st.events.toLocaleString() + " <small>" + fmtBytes(st.eventBytes) + "</small>"], ["index and overhead", fmtBytes(overhead)], ["files", st.blobs.toLocaleString() + " <small>" + fmtBytes(st.mediaBytes) + "</small>"]]
      .map(([k, v]) => "<div><small>" + k + "</small><b>" + v + "</b></div>").join("");
    const any = st.retention.find((r) => r.kind === null);
    const own = (kind) => { const r = st.retention.find((x) => x.kind === kind); return r ? r.days : ""; };
    const row = (k) => {
      const key = k.kind === null ? "" : String(k.kind);
      const placeholder = k.kind === null ? "forever" : k.replaceable || !any ? "forever" : any.days + " (everything else)";
      const pill = k.kind === null ? "everything else" : '<span class="kind' + (k.protected ? ' sys" title="required: the relay depends on this kind' : "") + '">' + k.kind + "</span> " + esc(kindName(k.kind));
      const cells = k.protected
        ? '<td class="keep sys" colspan="2" title="The relay depends on this kind, so it is never expired or purged.">required</td>'
        : '<td class="keep"><input class="txt num days" type="number" min="0" max="36500" placeholder="' + placeholder + '" value="' + own(k.kind) + '"> days</td><td class="r">' + ib("check", "Save keep-for rule", "saveretention", key) + ib("trash", "Purge", "purgekind", key, "danger") + "</td>";
      return '<tr class="' + (k.kind === null ? "any" : "") + '" data-kind="' + key + '"><td>' + pill + '</td><td class="r mono">' + (k.n === undefined ? "" : k.n.toLocaleString()) + '</td><td class="r mono">' + (k.bytes === undefined ? "" : fmtBytes(k.bytes)) + '</td><td class="dim">' + (k.oldest ? esc(fmtDay(k.oldest)) : "") + "</td>" + cells + "</tr>";
    };
    $("#kinds tbody").innerHTML = [...st.kinds, { kind: null, days: any ? any.days : 0 }].map(row).join("");
    loadListHistory().catch(() => {});
  }

  async function loadListHistory() {
    const rows = await rpc("listlisthistory");
    const labels = { 3: "follows", 10002: "relay list", 10003: "bookmarks", 30003: "bookmark list" };
    $("#listhistory tbody").innerHTML = rows.length ? rows.map((r) => '<tr><td>' + esc((labels[r.kind] || ("kind " + r.kind)) + (r.d ? " / " + r.d : "")) + '</td><td class="dim">' + esc(fmtTime(r.created_at)) + '</td><td class="dim">' + esc(fmtTime(r.saved_at)) + '</td><td class="r">' + ib("undo", "Restore this version", "restorelist", r.event_id) + '</td></tr>').join("") : '<tr><td colspan="4" class="muted">no older list versions yet</td></tr>';
  }

  let searchQuery = "";
  async function loadEvents(reset) {
    const list = searchQuery ? await rpc("searchevents", searchQuery, 200) : await rpc("listrecentevents", reset ? 50 : 200);
    $("#events tbody").innerHTML = list.length ? list.map((e) => '<tr><td class="dim">' + esc(fmtTime(e.created_at)) + '</td><td><span class="kind' + (SYS_KINDS.has(e.kind) ? ' sys" title="required: the relay depends on this kind' : "") + '">' + e.kind + '</span></td><td class="mono" title="' + e.pubkey + '">' + av(e.pubkey) + key(e.pubkey) + '</td><td class="c">' + esc(e.content) + '</td><td class="r">' + ib("pin", "Pin", "pinevent", e.id) + ib("trash", "Delete event", "deleteevent", e.id) + ib("ban", "Ban event", "banevent", e.id, "danger") + ib("banuser", "Ban author", "banpubkey", e.pubkey, "danger") + "</td></tr>").join("") : '<tr><td colspan="5" class="muted">no events yet</td></tr>';
    $("#more").classList.toggle("hidden", searchQuery || list.length < 50);
  }
  $("#searchform").onsubmit = guard(async (ev) => {
    searchQuery = ev.target.q.value.trim();
    $("#searchclear").classList.toggle("hidden", !searchQuery);
    await loadEvents(true);
  });
  $("#searchclear").onclick = guard(async () => {
    searchQuery = ""; $("#searchform").reset(); $("#searchclear").classList.add("hidden");
    await loadEvents(true);
  });
  async function loadPins() {
    const pins = await rpc("listpins");
    $("#pins-count").textContent = pins.length || "";
    $("#pins").innerHTML = pins.length ? pins.map((t) => '<li><i class="ev">' + (t[0] === "e" ? "event" : "address") + '</i><span class="mono">' + esc(t[1].length > 40 ? t[1].slice(0, 16) + "\u2026" + t[1].slice(-8) : t[1]) + "</span><span>" + ib("copy", "Copy", "copy", t[1]) + ib("x", "Unpin", "unpinevent", t[1]) + "</span></li>").join("") : '<li class="muted">nothing pinned</li>';
  }
  $("#pinform").onsubmit = guard(async (ev) => {
    await rpc("pinevent", ev.target.id.value.trim()); ev.target.reset(); toast("Pinned"); await loadPins();
  });

  // ---- actions ----
  const refresh = () => Promise.all([loadLists(), loadEvents(true), loadStorage(), loadPins()]);

  $("#copy").onclick = async () => { await navigator.clipboard.writeText(wsURL); toast("copied " + wsURL); };
  $("#signin").onclick = guard(async () => {
    if (!window.nostr) throw new Error("No nostr extension found. Install one (Alby, nos2x, …) and reload, or use a remote signer.");
    me = await window.nostr.getPublicKey();
    localStorage.setItem("me", me);
    renderHeader(); await loadAdmin(); await loadPeople();
  });
  $("#signin46").onclick = () => showRemote(null);
  $$(".remote").forEach((b) => { b.onclick = () => showRemote($("#" + b.dataset.note)); });
  $("#nccopy").onclick = async () => { await navigator.clipboard.writeText($("#nclink").href); toast("Link copied; paste it into your signer app"); };
  $("#bunkerform").onsubmit = guard(async (ev) => {
    $("#remotenote").textContent = "Connecting…";
    try { await connectBunker(ev.target.url.value); } catch (e) { $("#remotenote").textContent = e.message; throw e; }
    $("#remotenote").textContent = ""; ev.target.reset();
    await remoteDone();
  });
  $("#signout").onclick = async () => {
    if (remote) { const r = remote; remote = null; try { await withTimeout(r.logout(), 5000, "The signer"); } catch { /* the session is gone either way */ } }
    localStorage.removeItem("nip46");
    me = null; localStorage.removeItem("me"); renderHeader(); await loadAdmin(); await loadPeople();
  };
  const claimNow = async (note) => {
    if (!signer.ready()) { note.textContent = "Sign the claim with a nostr extension or a remote signer."; showRemote(note); return; }
    me = await signer.getPublicKey();
    const r = await rpc("claim");
    if (!r.claimed) throw new Error("Somebody else claimed it first.");
    localStorage.setItem("me", me);
    toast("It's yours.");
    await loadInfo(); await loadFuel(); await loadAdmin(); await loadPeople();
    if (r.converted && confirm("This relay began as a temporary one: anyone can write, and everything is deleted after 14 days. Switch to the default rules and keep everything from now on? Each rule can be changed later on the Rules and Storage tabs.")) {
      await rpc("resetrules"); toast("Rules reset"); await loadInfo(); await loadAdmin();
    }
  };
  $("#claim").onclick = guard(() => claimNow($("#claimnote")));
  $("#claimlease").onclick = guard(() => claimNow($("#leasenote")));
  // Jobs run in the background; the table follows them while the tab is open.
  let jobsTimer = 0;
  const fmtJob = (j) => {
    const what = j.kind === "mirror" ? "mirror site" : j.kind === "import" ? "import" : j.label === "backfill" ? "fetch my history" : j.kind === "pull" ? "pull" : "rebroadcast";
    const f = [];
    if (j.filter.authors) f.push(j.filter.authors.length === 1 && j.filter.authors[0] === me ? "my events" : j.filter.authors.length + " authors");
    if (j.filter.kinds) f.push("kinds " + j.filter.kinds.join(", "));
    if (j.filter.since) f.push("since " + fmtDay(j.filter.since));
    const when = j.every ? "every " + (j.every === 24 ? "day" : j.every + " h") + (j.nextRun ? ", next " + fmtTime(j.nextRun) : "") : "once";
    const l = j.last;
    const count = (stored, blobs, sent, refused) => (j.kind === "mirror" ? blobs.toLocaleString() + " files mirrored" : j.kind === "import" ? stored.toLocaleString() + " events" + ((j.last ? j.last.duplicates : j.duplicates) ? ", " + (j.last ? j.last.duplicates : j.duplicates) + " already here" : "") : j.kind === "pull" ? stored.toLocaleString() + " events" + (blobs ? ", " + blobs + " files" : "") : sent.toLocaleString() + " sent" + (refused ? ", " + refused + " refused" : ""));
    const res = j.running ? "running: " + count(j.stored, j.blobs, j.sent, j.refused) + "..." : !l ? "waiting" : l.error ? "failed: " + l.error : count(l.stored, l.blobs, l.sent, l.refused) + (l.skipped ? ", " + l.skipped + " skipped" : "") + ", " + fmtTime(l.finishedAt);
    const sources = j.running ? j.pullSources : l?.sources;
    const details = sources?.length ? '<details><summary>Source results</summary>' + sources.map((s) => '<p><code>' + esc(s.url) + '</code>: ' + esc(s.status) + ', ' + s.stored + ' stored, ' + s.skipped + ' skipped' + (s.error || s.warning ? '<br>' + esc(s.error || s.warning) : '') + '</p>').join('') + '</details>' : '';
    const targets = j.kind === "push" && j.targetStatus ? "<br><small>" + Object.entries(j.targetStatus).map(([u, s]) => esc(u) + ": " + esc(s.status)).join("<br>") + "</small>" : "";
    return "<tr><td>" + what + "</td><td class=\"mono\">" + j.relays.map(esc).join("<br>") + targets + "</td><td>" + (f.join(", ") || "everything") + "</td><td>" + when + "</td><td>" + esc(res) + details + "</td><td>" + (j.running ? "" : ib("undo", "Run now", "runjob", j.id)) + ib("x", "Remove", "removejob", j.id) + "</td></tr>";
  };
  async function pollJobs() {
    clearTimeout(jobsTimer);
    let jobs;
    try { jobs = await rpc("listjobs"); } catch { return; }
    $("#jobs tbody").innerHTML = jobs.length ? jobs.map(fmtJob).join("") : '<tr><td colspan="6" class="muted">no jobs yet</td></tr>';
    if (isOwner) {
      try {
        const deliveries = await rpc("deliverystatus");
        $("#deliveries tbody").innerHTML = deliveries.length ? deliveries.map((d) => '<tr><td class="mono" title="' + esc(d.event_id) + '">' + esc(d.event_id.slice(0, 12)) + '</td><td class="mono">' + esc(d.target) + '</td><td>' + esc(d.status) + '</td><td>' + d.attempts + '</td><td>' + esc(d.error || "") + '</td></tr>').join("") : '<tr><td colspan="5" class="muted">no automatic deliveries yet</td></tr>';
      } catch { /* unavailable to non-owners */ }
    }
    if (jobs.some((j) => j.running || (j.nextRun && j.nextRun <= Math.floor(Date.now() / 1000) + 1))) jobsTimer = setTimeout(pollJobs, 3000);
  }
  const urls = (s) => s.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);
  const kindsOf = (s) => s.split(/[\s,]+/).map((k) => parseInt(k, 10)).filter((k) => Number.isInteger(k) && k >= 0);
  $("#pullform").onsubmit = guard(async (ev) => {
    const f = ev.target;
    await rpc("addjob", { kind: "pull", relays: [f.url.value.trim()], every: +f.every.value });
    toast(+f.every.value ? "Mirror scheduled" : "Pull started"); f.reset(); await pollJobs();
  });
  $("#backfillform").onsubmit = guard(async (ev) => {
    const f = ev.target;
    await rpc("backfill", urls(f.relays.value));
    toast("Fetching your history"); f.reset(); await pollJobs();
  });
  $("#pushform").onsubmit = guard(async (ev) => {
    const f = ev.target;
    const filter = {};
    const kinds = kindsOf(f.kinds.value); if (kinds.length) filter.kinds = kinds;
    const days = +f.days.value; if (days > 0) filter.since = Math.floor(Date.now() / 1000) - days * 86400;
    await rpc("addjob", { kind: "push", relays: urls(f.targets.value), filter, every: +f.every.value });
    toast("Rebroadcast started"); f.reset(); await pollJobs();
  });
  // ---- presets: writes, reads, kinds and keep-for rules in one click ----
  let presets = null;
  async function renderPresets() {
    if (!presets) { try { presets = await rpc("listpresets"); } catch { presets = []; } }
    $("#presets").innerHTML = presets.map((p) => '<button class="btn" data-preset="' + esc(p.name) + '" title="' + esc(p.about) + '">' + esc(p.title) + "</button>").join("");
    $("#presetsourcerow").classList.toggle("hidden", !presets.some((p) => p.source));
  }
  $("#presets").addEventListener("click", async (ev) => {
    const b = ev.target.closest("button[data-preset]"); if (!b) return;
    const p = (presets || []).find((x) => x.name === b.dataset.preset); if (!p) return;
    if (!confirm(p.title + ": " + p.about + "\n\nThis replaces the writes and reads rules, the directory setting, the kind rules and the keep-for rules. Limits, identity, people and bans stay.")) return;
    const source = $("#presetsource").value.trim();
    if (p.source === "required" && !source) { $("#presetnote").textContent = p.title + " needs a source relay to mirror; enter its wss:// URL first."; return; }
    b.disabled = true;
    try { policy = await rpc("applypreset", p.name, p.source && source ? { source } : undefined); $("#presetnote").textContent = "Now: " + p.about + (policy.job ? " Mirroring " + source + " every " + policy.job.every + " h." : ""); toast(p.title + " applied"); await loadInfo(); await loadAdmin(); }
    catch (e) { toast(e.message); } finally { b.disabled = false; }
  });

  // ---- wire me in: this relay in the owner's own lists ----
  // The lists are replaceable, so a fresh list with only this relay would
  // clobber the real one once it spread. Every publish starts from the
  // newest copy found here or on the indexers, verified when the signer
  // library is around, and adds or removes this relay in it.
  const INDEXERS = ["wss://purplepag.es", "wss://relay.nostr.band", "wss://relay.damus.io", "wss://nos.lol"];
  const LISTS = [
    { kind: 10002, tag: "r", title: "Relay list", nip: "NIP-65", about: "where clients read your notes and send you mentions" },
    { kind: 10050, tag: "relay", title: "DM inbox", nip: "NIP-17", about: "where people send you private messages" },
    { kind: 10007, tag: "relay", title: "Search relays", nip: "NIP-51", about: "where clients run your searches" },
    { kind: 10063, tag: "server", title: "Blossom servers", nip: "BUD-03", about: "where clients upload and look for your files" },
  ];
  const mineFor = (l) => (l.tag === "server" ? location.origin : wsURL);
  const normURL = (u) => { try { const x = new URL(String(u).trim()); return (x.host + x.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return String(u).trim().toLowerCase(); } };
  const isMine = (l, t) => t[0] === l.tag && normURL(t[1] || "") === normURL(mineFor(l));
  const listHas = (list, l) => !!list && list.tags.some((t) => isMine(l, t));
  // mergeList is pure: the newest list with this relay put first or taken out, every other tag kept.
  function mergeList(list, l, include) {
    const tags = (list ? list.tags : []).filter((t) => !isMine(l, t));
    if (include) tags.unshift([l.tag, mineFor(l)]);
    return { kind: l.kind, created_at: Math.floor(Date.now() / 1000), content: list ? list.content : "", tags };
  }
  const relaysIn = (list) => list.tags.filter((t) => (t[0] === "r" || t[0] === "relay") && /^wss?:\/\//i.test(t[1] || "")).map((t) => t[1].trim());
  // overWS opens one socket, sends one message, feeds answers to onMessage until it says done or time runs out.
  function overWS(url, ms, first, onMessage) {
    return new Promise((res) => {
      let ws = null, done = false, out = null;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); try { if (ws) ws.close(); } catch { /* closed */ } res(out); };
      const timer = setTimeout(finish, ms);
      try { ws = new WebSocket(url); } catch { return finish(); }
      ws.onopen = () => ws.send(JSON.stringify(first));
      ws.onmessage = (m) => { let d; try { d = JSON.parse(m.data); } catch { return; } if (!Array.isArray(d)) return; if (onMessage(d, (v) => { out = v; })) finish(); };
      ws.onerror = finish; ws.onclose = finish;
    });
  }
  function fetchNewest(url, filter, ms) {
    let best = null;
    return overWS(url, ms, ["REQ", "w", filter], (d, set) => {
      if (d[0] === "EVENT" && d[1] === "w" && d[2] && (!best || d[2].created_at > best.created_at)) { best = d[2]; set(best); }
      return (d[0] === "EOSE" || d[0] === "CLOSED") && d[1] === "w";
    });
  }
  function publishTo(url, event, ms) {
    return overWS(url, ms, ["EVENT", event], (d, set) => { if (d[0] === "OK" && d[1] === event.id) { set({ url, ok: !!d[2], msg: d[3] || "" }); return true; } return false; })
      .then((r) => r || { url, ok: false, msg: "no answer" });
  }
  // bridge signs a NIP-98 request to this relay's HTTP door, so the owner's own reads and writes pass any read rule.
  async function bridge(path, body) {
    const url = location.origin + path, raw = JSON.stringify(body);
    const ev = await signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags: [["u", url], ["method", "POST"], ["payload", await sha256hex(raw)]] });
    const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Nostr " + btoa(JSON.stringify(ev)) }, body: raw });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || "HTTP " + resp.status);
    return json;
  }
  const wire = {};
  function renderWire() {
    const pill = (state) => {
      const cls = state === "listed" ? "on" : state === "failed" ? "bad" : state === "not listed" ? "off" : "";
      const label = state === "checking" || state === "publishing" ? state + "\u2026" : state;
      return '<span class="pill ' + cls + '">' + esc(label) + "</span>";
    };
    $("#wire").innerHTML = LISTS.map((l) => {
      const w = wire[l.kind] || { state: "", results: [], list: null };
      const busy = w.state === "checking" || w.state === "publishing";
      const btn = (act, cls, label) => '<button class="btn ' + cls + '" data-wire="' + l.kind + '" data-do="' + act + '"' + (busy ? " disabled" : "") + ">" + label + "</button>";
      const buttons = w.state === "listed" ? btn("remove", "", "Remove this relay") : btn("add", "pri", "Add this relay") + btn("check", "", w.state ? "Check again" : "Check");
      const n = w.list ? w.list.tags.filter((t) => t[0] === l.tag).length : 0;
      const from = w.list ? "<span>" + (n === 1 ? "1 entry" : n + " entries") + ", " + fmtTime(w.list.created_at) + "</span>" : w.state && !busy ? "<span>no list found</span>" : "";
      const sent = (w.results || []).map((r) => '<span class="chip' + (r.ok ? "" : " bad") + '" title="' + esc(r.msg) + '">' + esc(r.url.replace(/^wss?:\/\//, "")) + (r.ok ? "" : " failed") + "</span>").join("");
      const meta = (w.state ? pill(w.state) : "") + from + sent;
      return '<div class="wire-row"><div class="wire-main"><b>' + l.title + '</b> <small class="muted">' + l.nip + "</small><br><small>" + l.about + '</small></div><div class="wire-side"><div class="wire-acts">' + buttons + '</div><div class="wire-meta">' + meta + "</div></div></div>";
    }).join("");
  }
  async function wireCheck(l) {
    const w = (wire[l.kind] = { state: "checking", list: null, results: [] }); renderWire();
    const filter = { kinds: [l.kind], authors: [me], limit: 1 };
    const found = [];
    try { found.push(...(await bridge("/query", [filter]))); } catch { /* the relay may hold none */ }
    const remote = await Promise.all(INDEXERS.map((u) => fetchNewest(u, filter, 4000)));
    let lib = null; try { lib = await signerLib(); } catch { /* unverified lists are still the owner's own, by pubkey */ }
    for (const e of remote) if (e && e.pubkey === me && e.kind === l.kind && Array.isArray(e.tags) && (!lib || lib.verifyEvent(e))) found.push(e);
    w.list = found.sort((a, b) => b.created_at - a.created_at)[0] || null;
    w.state = listHas(w.list, l) ? "listed" : "not listed"; renderWire();
  }
  async function wirePublish(l, include) {
    if (!wire[l.kind] || !wire[l.kind].state || wire[l.kind].state === "failed") await wireCheck(l);
    const w = wire[l.kind]; w.state = "publishing"; w.results = []; renderWire();
    try {
      const signed = await signer.signEvent(mergeList(w.list, l, include));
      const here = await bridge("/events", signed).then((r) => ({ url: wsURL, ok: !!r.accepted, msg: r.message || "" })).catch((e) => ({ url: wsURL, ok: false, msg: e.message }));
      const targets = [...new Set([...relaysIn(signed), ...INDEXERS])].filter((u) => normURL(u) !== normURL(wsURL));
      const rest = await Promise.all(targets.map((u) => publishTo(u, signed, 6000)));
      w.results = [here, ...rest]; w.list = signed; w.state = include ? "listed" : "not listed";
      toast((include ? "Added to your " : "Removed from your ") + l.title.toLowerCase());
    } catch (e) { w.state = "failed"; w.results = [{ url: wsURL, ok: false, msg: e.message }]; toast(e.message); }
    renderWire();
  }
  $("#wire").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-wire]"); if (!b) return;
    const l = LISTS.find((x) => String(x.kind) === b.dataset.wire); if (!l) return;
    if (b.dataset.do === "check") wireCheck(l); else wirePublish(l, b.dataset.do === "add");
  });

  // ---- custom domains: this relay under a hostname the owner controls ----
  let domainSites = [];
  const domainOptions = (current = "") => [{ label: "", title: "This relay" }, ...domainSites.map((s) => ({ label: s.label, title: (s.d || (s.kind === 5128 ? "snapshot" : "root")) + " / " + key(s.author) })), ...(current && !domainSites.some((s) => s.label === current) ? [{ label: current, title: "Site " + current }] : [])].map((s) => '<option value="' + esc(s.label) + '"' + (s.label === current ? " selected" : "") + ">" + esc(s.title) + "</option>").join("");
  let domains = null; // null: not enabled on this host
  function renderDomains() {
    $("#domains").innerHTML = (domains || []).map((d) => {
      const state = d.ready ? "active" : "hostname " + d.status.replace(/_/g, " ") + ", certificate " + d.sslStatus.replace(/_/g, " ");
      const btn = (act, cls, label) => '<button class="btn ' + cls + '" data-domain="' + esc(d.host) + '" data-do="' + act + '">' + label + "</button>";
      const rows = d.ready ? "" : '<div class="scroll"><table class="events"><thead><tr><th>Type</th><th>Name</th><th>Value</th><th></th></tr></thead><tbody>' + d.records.map((r) => "<tr><td>" + esc(r.type) + '</td><td class="mono">' + esc(r.name) + '</td><td class="mono">' + esc(r.value) + "</td><td>" + esc(r.note) + "</td></tr>").join("") + "</tbody></table></div>";
      return '<div class="row"><b class="mono">' + esc(d.host) + '</b><span class="note">' + esc(state) + "</span>" + btn("check", "", "Check") + btn("remove", "danger", "Remove") + '</div><label class="row"><span>Destination</span><select class="txt" data-domain-site="' + esc(d.host) + '">' + domainOptions(d.site || "") + "</select></label>" + rows;
    }).join("");
  }
  async function loadDomains() {
    try { [domains, domainSites] = await Promise.all([rpc("listdomains"), rpc("listsites")]); $("#adddomain select[name=site]").innerHTML = domainOptions(); $("#domainnote").textContent = domains.length ? "" : "No custom domain yet."; $("#adddomain").classList.remove("hidden"); }
    catch (e) { domains = null; $("#domainnote").textContent = /^unsupported/.test(e.message) ? "Custom domains are not enabled on this host." : e.message; $("#adddomain").classList.add("hidden"); }
    renderDomains();
  }
  $("#adddomain").onsubmit = guard(async (ev) => {
    const f = ev.target;
    await rpc("adddomain", f.host.value.trim(), f.site.value); f.reset(); toast("Domain added; now create the CNAME"); await loadDomains();
  });
  $("#domains").addEventListener("change", guard(async (ev) => {
    const select = ev.target.closest("select[data-domain-site]"); if (!select) return;
    await rpc("setdomainsite", select.dataset.domainSite, select.value);
    toast("Domain destination saved"); await loadDomains();
  }));
  $("#domains").addEventListener("click", async (ev) => {
    const b = ev.target.closest("button[data-domain]"); if (!b) return;
    const host = b.dataset.domain;
    if (b.dataset.do === "remove" && !confirm("Remove " + host + "? Its certificate goes with it and the name stops answering.")) return;
    b.disabled = true;
    try {
      if (b.dataset.do === "remove") { await rpc("removedomain", host); toast("Removed"); }
      else { const d = await rpc("checkdomain", host); toast(d.ready ? host + " is live" : "Not yet: " + (d.status === "active" ? "certificate pending" : "waiting for the CNAME")); }
      await loadDomains();
    } catch (e) { toast(e.message); } finally { b.disabled = false; }
  });

  $("#access").onsubmit = guard(async (ev) => {
    const f = ev.target;
    const openKinds = f.openKinds.value.split(/[\s,]+/).filter(Boolean).map(Number);
    if (openKinds.some((k) => !Number.isInteger(k) || k < 0 || k > 65535)) throw new Error("Open kinds must be whole numbers.");
    policy = await rpc("setpolicy", { writes: f.writes.value, reads: f.reads.value, openKinds, guestReplies: f.guestReplies.checked, minPow: +f.minPow.value, maxFuture: +f.maxFuture.value, maxLimit: +f.maxLimit.value, maxSubs: +f.maxSubs.value, maxMessageKB: +f.maxMessageKB.value, eventsPerMinute: +f.eventsPerMinute.value, reqsPerMinute: +f.reqsPerMinute.value, maxBlobMB: +f.maxBlobMB.value });
    toast("Rules saved"); await loadInfo();
  });
  $("#notify").onsubmit = guard(async (ev) => {
    const f = ev.target;
    policy = await rpc("setpolicy", { notify: { reports: f.reports.checked, fuel: f.fuel.checked, jobs: f.jobs.checked, succession: f.succession.checked, digest: f.digest.checked } });
    toast("Notifications saved");
  });
  $("#notifytest").onclick = guard(async () => {
    const r = await rpc("notifytest");
    toast(r.sent ? "Sent. Look for a message from the relay in your DMs." : "Could not send.");
  });
  $("#identity").onsubmit = guard(async (ev) => {
    const f = ev.target;
    const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
    policy = await rpc("setpolicy", { name: f.name.value, contact: f.contact.value, description: f.description.value, icon: f.icon.value,
      banner: f.banner.value, postingPolicy: f.postingPolicy.value, privacyPolicy: f.privacyPolicy.value, tags: list(f.tags.value), languageTags: list(f.languageTags.value), relayCountries: list(f.relayCountries.value) });
    toast("Identity saved"); await loadInfo(); await loadPeople(); loadCard();
  });
  $("#addmember").onsubmit = guard(async (ev) => {
    const f = ev.target; const pk = npubToHex(f.pubkey.value); if (!pk) throw new Error("That is not a pubkey.");
    await rpc("setmember", pk, { name: f.name.value.trim() || null, note: f.note.value }); f.reset(); toast("Member added"); await loadLists();
  });
  $("#addblock").onsubmit = guard(async (ev) => {
    const f = ev.target;
    await rpc("blockip", f.ip.value.trim(), f.reason.value); f.reset(); toast("Blocked"); await loadLists();
  });
  $("#wordsform").onsubmit = guard(async (ev) => {
    const words = ev.target.words.value.split("\n").map((s) => s.trim()).filter(Boolean);
    const kept = await rpc("setblockedwords", words);
    policy = await rpc("setpolicy", { blockedWordsInTags: ev.target.inTags.checked });
    ev.target.words.value = kept.join("\n"); toast(kept.length ? kept.length + " words blocked" : "No words blocked");
  });
  $("#thresholdform").onsubmit = guard(async (ev) => {
    policy = await rpc("setpolicy", { reportThreshold: +ev.target.reportThreshold.value });
    toast(policy.reportThreshold ? "Hidden after " + policy.reportThreshold + " reports" : "Never hidden by reports"); await loadLists();
  });
  $("#addban").onsubmit = guard(async (ev) => {
    const pk = npubToHex(ev.target.pubkey.value); if (!pk) throw new Error("That is not a pubkey.");
    await rpc("banpubkey", pk, ev.target.reason.value, ev.target.erase.checked); ev.target.reset(); toast(ev.target.erase.checked ? "Banned and erased" : "Banned"); await loadLists();
  });
  $("#mintinvite").onsubmit = guard(async (ev) => {
    const f = ev.target;
    const inv = await rpc("createinvite", +f.ttl.value, +f.max.value, f.note.value);
    await navigator.clipboard.writeText(location.origin + "/invite/" + inv.code).catch(() => {});
    f.note.value = ""; toast("Invite created and copied"); await loadLists();
  });
  $("#kindform").onsubmit = guard(async (ev) => {
    const rule = ev.submitter.value; const k = +ev.target.kind.value;
    await rpc(rule === "allow" ? "allowkind" : "disallowkind", k); ev.target.reset(); toast((rule === "allow" ? "Allowed kind " : "Blocked kind ") + k); await loadLists();
  });
  $("#more").onclick = guard(() => loadEvents(false));
  $("#dumpform").onsubmit = guard(async (ev) => {
    const f = ev.target;
    policy = await rpc("setpolicy", { dumps: f.dumps.value, dumpsKeep: Math.max(1, Math.min(60, Math.floor(+f.keep.value || 7))) });
    toast(policy.dumps === "off" ? "Dumps off" : "Dumping " + policy.dumps); await loadDumps();
  });
  $("#importform").onsubmit = guard(async (ev) => {
    const file = ev.target.file.files[0]; if (!file) return;
    if (!signer.ready()) throw new Error(NO_SIGNER);
    if (file.size > 64 * 1024 * 1024) throw new Error("At most 64 MB per import.");
    const body = await file.text();
    const url = location.origin + "/import?name=" + encodeURIComponent(file.name);
    const token = await signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags: [["u", url], ["method", "PUT"], ["payload", await sha256hex(body)]] });
    const resp = await fetch(url, { method: "PUT", headers: { authorization: "Nostr " + btoa(JSON.stringify(token)), "content-type": "application/x-ndjson" }, body });
    const r = await resp.json();
    if (!resp.ok) throw new Error(r.error || "import failed");
    ev.target.reset(); toast("Importing " + fmtBytes(r.bytes)); await pollJobs();
  });
  $("#dumpnow").onclick = guard(async () => { const d = await rpc("dumpnow"); toast("Dumped " + d.events.toLocaleString() + " events"); await loadStorage(); });
  $("#treeform").onsubmit = guard(async (ev) => {
    const f = ev.target;
    policy = await rpc("setpolicy", { memberInvites: { depth: Math.max(0, Math.floor(+f.depth.value || 0)), quota: Math.max(0, Math.floor(+f.quota.value || 0)) } });
    toast(policy.memberInvites.depth ? "Members may invite" : "Only you and moderators invite");
  });
  $("#mintmine").onclick = guard(async () => {
    const inv = await rpc("createinvite", 259200, 1, "");
    await navigator.clipboard.writeText(location.origin + "/invite/" + inv.code).catch(() => {});
    toast("Invite created and copied"); await loadMine();
  });
  $("#exportcfg").onclick = guard(async () => {
    const cfg = await rpc("exportconfig");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" }));
    a.download = host.split(".")[0] + ".bind.ws.config.json";
    a.click(); URL.revokeObjectURL(a.href);
  });
  $("#importcfg").onclick = () => $("#cfgfile").click();
  $("#cfgfile").onchange = guard(async (ev) => {
    const file = ev.target.files[0]; if (!file) return;
    const cfg = JSON.parse(await file.text());
    const check = await rpc("importconfig", cfg, { dryRun: true });
    const lines = check.changes.summary.length ? check.changes.summary.join("\n") : "Nothing would change.";
    const dropped = check.warnings.length ? "\n\nNot taken:\n" + check.warnings.join("\n") : "";
    if (!confirm("Apply " + file.name + " to this relay?\n\n" + lines + dropped)) { ev.target.value = ""; return; }
    await rpc("importconfig", cfg); ev.target.value = ""; toast("Configuration imported"); await loadInfo(); await loadAdmin(); await loadPeople();
  });
  // Succession: the status line under the heir form, from successionstatus.
  async function renderSuccession() {
    const el = $("#successionnote"), f = $("#succession");
    let st;
    try { st = await rpc("successionstatus"); } catch { el.textContent = ""; return; }
    const sc = st.succession;
    $("#clearsuccession").classList.toggle("hidden", !sc);
    f.querySelector("button.btn:not(#clearsuccession)").textContent = sc ? "Change heir" : "Set heir";
    if (!sc) { el.textContent = "No heir named. Last signed in " + fmtTime(st.ownerSeenAt) + "."; return; }
    if (f.heir.querySelector('[value="' + sc.heir + '"]')) f.heir.value = sc.heir;
    f.afterDays.value = String(sc.afterDays);
    const who = (window.__members || []).find((m) => m.pubkey === sc.heir);
    const heir = who && who.name ? who.name + "@" + host : short(sc.heir);
    el.textContent = "Heir: " + heir + ". Last signed in " + fmtTime(st.ownerSeenAt) + (st.silentDays ? " (" + st.silentDays + " days ago)" : "") + ". " +
      (st.warning ? "The warning month is running: the relay goes to " + heir + " on " + fmtDay(st.handoverAt) + " unless you sign in." : "If you stay away, it goes to " + heir + " around " + fmtDay(st.handoverAt) + ".") +
      (st.log && st.log.length ? " Handed over before: " + st.log.map((l) => fmtDay(l.at) + " to " + short(l.to)).join(", ") + "." : "");
  }
  $("#succession").onsubmit = guard(async (ev) => {
    const f = ev.target;
    await rpc("setsuccession", { heir: f.heir.value, afterDays: +f.afterDays.value });
    toast("Heir set"); await loadAdmin();
  });
  $("#clearsuccession").onclick = guard(async () => {
    await rpc("clearsuccession");
    toast("Heir cleared"); await loadAdmin();
  });
  $("#transfer").onsubmit = guard(async (ev) => {
    const pk = ev.target.pubkey.value; if (!pk) return;
    const name = host.split(".")[0];
    const typed = prompt("This hands " + host + " to " + short(pk) + " for good. You stay on as a moderator. Type the relay name (" + name + ") to confirm.");
    if (typed === null) return;
    if (typed.trim() !== name) { toast("That didn't match; nothing changed."); return; }
    await rpc("transferowner", pk);
    toast("Transferred");
    await loadInfo(); await loadAdmin(); await loadPeople();
  });
  // ---- fork: a new name with this relay's events, claim reserved for a key ----
  $("#forkform").scope.onchange = (ev) => $("#forkkinds").classList.toggle("hidden", ev.target.value !== "kinds");
  $("#joinform").onsubmit = guard(async (ev) => {
    const f = ev.target;
    policy = await rpc("setpolicy", { joinTerms: f.joinTerms.value, directoryPublic: f.directoryPublic.checked });
    toast("Saved"); await loadInfo(); await loadPeople();
  });
  $("#forkform").onsubmit = guard(async (ev) => {
    const f = ev.target;
    const opts = { people: f.people.checked };
    if (f.name.value.trim()) opts.name = f.name.value.trim().toLowerCase();
    if (f.holder.value.trim()) { const pk = npubToHex(f.holder.value); if (!pk) throw new Error("That is not a pubkey."); opts.holder = pk; }
    if (f.scope.value === "mine") opts.filter = { authors: [me] };
    if (f.scope.value === "kinds") { const kinds = f.kinds.value.split(/[\s,]+/).filter(Boolean).map(Number); if (!kinds.length || kinds.some((k) => !Number.isInteger(k) || k < 0)) throw new Error("Give kinds as numbers."); opts.filter = { kinds }; }
    if (!confirm("Fork this relay into a new name" + (opts.name ? " (" + opts.name + ")" : "") + "? It pulls " + (f.scope.value === "all" ? "everything" : f.scope.value === "mine" ? "your events" : "the chosen kinds") + (opts.people ? " and the people" : "") + ", and only " + (opts.holder ? "that key" : "you") + " can claim it.")) return;
    const r = await rpc("forkrelay", opts);
    $("#forknote").textContent = r.handover + " Expires " + fmtTime(r.expires_at) + ".";
    $("#forkurl").textContent = r.console;
    $("#forkresult").classList.remove("hidden");
    toast("Forked to " + r.name);
  });
  $("#forkcopy").onclick = async () => { await navigator.clipboard.writeText($("#forkurl").textContent); toast("copied"); };
  $("#deleterelay").onclick = guard(async () => {
    const name = host.split(".")[0];
    const typed = prompt("This deletes everything on " + host + " and gives the name up. Type the relay name (" + name + ") to confirm.");
    if (typed === null) return;
    if (typed.trim() !== name) { toast("That didn't match; nothing was deleted."); return; }
    await rpc("deleterelay", name);
    localStorage.removeItem("me");
    location.href = "/";
  });
  $("#topup").onsubmit = guard((ev) => topUp(+ev.target.sats.value));
  $("#inv-copy").onclick = async () => { await navigator.clipboard.writeText($("#inv-text").value); toast("invoice copied"); };
  $$("button[data-copy]").forEach((b) => { b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.copy === "ws" ? wsURL : location.origin); toast("copied"); }; });
  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button[data-act]"); if (!b) return;
    const act = b.dataset.act, id = b.dataset.id;
    if (act === "copy") { await navigator.clipboard.writeText(id); toast("copied"); return; }
    if ((act === "banpubkey" || act === "banevent" || act === "resolve:ban") && !confirm(act === "banevent" ? "Delete this event and refuse it forever?" : "Ban this author and refuse everything they post?")) return;
    const erase = (act === "banpubkey" || act === "resolve:ban") && confirm("Also erase everything they wrote and uploaded here?");
    if (act === "deleteblob" && !confirm("Delete this file for good?")) return;
    if (act === "deletedump" && !confirm("Delete this dump?")) return;
    if (act === "downloaddump") { b.disabled = true; try { await downloadDump(id); } catch (e) { toast(e.message); } finally { b.disabled = false; } return; }
    if (act === "restorelist") {
      if (!signer.ready()) { toast(NO_SIGNER); return; }
      try {
        const preview = await rpc("restorelist", id);
        const d = preview.diff || {};
        const added = (d.addedTags || []).map((t) => "+ " + JSON.stringify(t)).join("\n");
        const removed = (d.removedTags || []).map((t) => "- " + JSON.stringify(t)).join("\n");
        const changes = [added, removed, d.contentChanged ? "content changed" : "content unchanged"].filter(Boolean).join("\n");
        if (!confirm("Restore this list version?\n\n" + (changes || "No tag or content changes") + "\n\nIt will be signed and published as the newest version.")) return;
        const signed = await signer.signEvent(preview.draft);
        const result = await bridge("/events", signed);
        if (!result.accepted) throw new Error(result.message || "The relay refused the restored list.");
        toast("List restored"); await loadListHistory(); await loadStorage();
      } catch (e) { toast(e.message); } finally { b.disabled = false; }
      return;
    }
    if ((act === "removemember" || act === "banpubkey") && (window.__members || []).some((m) => m.invited_by === id) && confirm("Also remove everyone this member invited, and everyone they invited in turn?")) {
      b.disabled = true;
      try { const r = await rpc("removesubtree", id); if (act === "banpubkey") await rpc("banpubkey", id, "", erase); toast("Removed " + r.removed.length); await refresh(); } catch (e) { toast(e.message); } finally { b.disabled = false; }
      return;
    }
    if (act === "removejob" && !confirm("Remove this job?")) return;
    if (act === "purgekind") {
      const kind = id === "" ? null : +id;
      const label = kind === null ? "everything without its own rule" : kindName(kind) + " (kind " + kind + ")";
      const typed = prompt("Purge " + label + " older than how many days? 0 purges all of them. This cannot be undone.", "30");
      if (typed === null) return;
      const days = Math.max(0, Math.floor(+typed || 0));
      b.disabled = true;
      try { const r = await rpc("purgekind", kind, days); toast("Purged " + r.deleted.toLocaleString() + " events"); await refresh(); } catch (e) { toast(e.message); } finally { b.disabled = false; }
      return;
    }
    if (act === "saveretention") {
      const kind = id === "" ? null : +id;
      const days = Math.max(0, Math.floor(+b.closest("tr").querySelector(".days").value || 0));
      b.disabled = true;
      try { await rpc("setretention", kind, days); toast(days ? "Kept for " + days + " days" : "Kept forever"); await loadStorage(); await loadInfo(); } catch (e) { toast(e.message); } finally { b.disabled = false; }
      return;
    }
    b.disabled = true;
    try {
      if (act === "savemember") { const tr = b.closest("tr"), role = tr.querySelector("select.role"), keep = tr.querySelector(".keep"), cap = tr.querySelector(".cap"); await rpc("setmember", id, { name: tr.querySelector(".name").value.trim() || null, note: tr.querySelector(".note").value, ...(role ? { role: role.value } : {}), ...(keep ? { keepDays: Math.max(0, Math.floor(+keep.value || 0)), maxBytes: Math.max(0, Math.floor(+cap.value || 0)) * 1024 } : {}) }); }
      else if (act.startsWith("resolve:")) await rpc("resolvereport", id, act.slice(8), erase);
      else if (act === "banpubkey") await rpc("banpubkey", id, "", erase);
      else await rpc(act, act === "unrulekind" ? +id : id, "");
      toast("Done"); await (myRole ? refresh() : loadMine());
      if (act === "pinevent" || act === "unpinevent") await loadPins();
    } catch (e) { toast(e.message); } finally { b.disabled = false; }
  });

  // The share block: the card picture, the group naddr and its QR.
  let card = null;
  async function loadCard() {
    try {
      card = await (await fetch("/card.json", { cache: "no-store" })).json();
      $("#cardimg").src = "/card.svg?t=" + Date.now();
      $("#naddr").textContent = card.naddr || "";
      const q = $("#naddrqr");
      if (card.naddr) { q.src = "/qr.svg?text=" + encodeURIComponent(card.naddr); q.classList.remove("hidden"); } else q.classList.add("hidden");
    } catch { /* the card is decoration */ }
    renderApps();
  }
  // The app rows on the Connect section: one per client people actually use,
  // with the link that lands on this relay in it. Relay apps take the relay
  // or the group address; feed apps take the owner's profile with this relay
  // as the hint, since they have no notion of opening a relay.
  function renderApps() {
    const el = $("#apps"); if (!el) return;
    const enc = encodeURIComponent;
    const nprofile = card && card.nprofile ? card.nprofile : "";
    const naddr = card && card.naddr ? card.naddr : "";
    const whose = me && owner && me === owner ? "your" : "the owner's";
    const link = (label, href) => '<a class="btn" href="' + esc(href) + '" target="_blank" rel="noopener">' + label + "</a>";
    const app = (label, uri) => '<a class="btn" href="' + esc(uri) + '">' + label + "</a>";
    const copy = (label, text) => '<button class="btn" data-copytext="' + esc(text) + '">' + label + "</button>";
    const row = (name, where, note, acts) => '<div class="app"><div class="app-head"><b>' + name + "</b><small>" + where + "</small></div><p>" + note + '</p><div class="app-acts">' + acts.filter(Boolean).join("") + "</div></div>";
    const profileNote = "Opens " + whose + " profile with this relay attached.";
    const groups = [
      ["As a place", "These open the relay itself: its feed, its people, its group.", [
        row("Jumble", "web", "A feed of everything on this relay.", [link("Open", "https://jumble.social/?r=" + enc(wsURL))]),
        row("Coracle", "web", "The relay's page: its feed and its people.", [link("Open", "https://coracle.social/relays/" + enc(host))]),
        row("Flotilla", "web, phone", "The relay as a space, with the group as a room.", [link("Open", "https://app.flotilla.social/spaces/" + enc(host)), naddr && app("Open group", "nostr:" + naddr)]),
        row("0xchat", "phone", "The group, in a chat app.", [naddr && app("Open group", "nostr:" + naddr), naddr && copy("Copy naddr", naddr)]),
        row("noStrudel", "web", "Relays, add this one, then open its page.", [copy("Copy relay URL", wsURL)]),
      ]],
      ["Find me here", "Feed apps have no relay pages. They meet this relay through a profile link that names it, then keep it once it is in the relay settings.", [
        row("Primal", "web, phone", profileNote, [nprofile && link("Open", "https://primal.net/p/" + nprofile), nprofile && app("Open in app", "nostr:" + nprofile)]),
        row("YakiHonne", "web, phone", profileNote, [nprofile && link("Open", "https://yakihonne.com/profile/" + nprofile), nprofile && app("Open in app", "nostr:" + nprofile)]),
        row("Damus", "iPhone", profileNote + " Then Settings, Relays.", [nprofile && app("Open in app", "nostr:" + nprofile), copy("Copy relay URL", wsURL)]),
        row("Amethyst", "Android", profileNote + " Then Relays in the drawer.", [nprofile && app("Open in app", "nostr:" + nprofile), copy("Copy relay URL", wsURL)]),
        row("Nostur", "iPhone, Mac", profileNote + " Then Settings, Relays.", [nprofile && app("Open in app", "nostr:" + nprofile), copy("Copy relay URL", wsURL)]),
      ]],
    ];
    if (info?.supported_grasps?.includes("GRASP-01")) groups.push([
      "Git repositories", "Use this relay with a Git client.", [
        row("GitWorkshop", "web", "Browse this relay's Git repositories.", [link("Open in app", "https://gitworkshop.dev/relay/" + enc((wsURL.startsWith("ws://") ? "ws:" : "") + host)), copy("Copy relay URL", wsURL)]),
      ],
    ]);
    el.innerHTML = groups.map(([h, note, rows]) => '<div class="appgroup"><h4>' + h + '</h4><p class="note">' + note + '</p><div class="appgrid">' + rows.join("") + "</div></div>").join("");
    $("#apps-ws").textContent = wsURL;
    const tile = (label, text) => '<div class="door"><small>' + label + '</small><img src="/qr.svg?text=' + enc(text) + '" alt="QR code: ' + esc(label) + '" width="150" height="150"></div>';
    $("#phones").innerHTML = [nprofile && tile("Find me here, for a phone", "nostr:" + nprofile), naddr && tile("The group, for a phone", "nostr:" + naddr)].filter(Boolean).join("");
  }
  // The folds are a group: opening one closes the rest. Browsers with the
  // details name attribute do this themselves; this covers the others.
  $$(".folds details").forEach((d) => d.addEventListener("toggle", () => { if (d.open) $$(".folds details").forEach((o) => { if (o !== d && o.open) o.open = false; }); }));
  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button[data-copytext]"); if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copytext); toast("copied"); } catch { /* no clipboard */ }
  });
  $("#copynaddr").onclick = async () => { if (!card || !card.naddr) return; await navigator.clipboard.writeText(card.naddr); toast("copied naddr"); };
  $("#copyembed").onclick = async () => { await navigator.clipboard.writeText('<a href="' + location.origin + '/"><img src="' + location.origin + '/card.svg" alt="' + host + '" width="600" height="315"></a>'); toast("copied embed"); };

  // A click on a key copies it; a double-click selects the whole key so the usual copy shortcut takes it too.
  document.addEventListener("dblclick", (ev) => {
    const k = ev.target.closest(".key"); if (!k) return;
    const s = window.getSelection(), r = document.createRange(); r.selectNodeContents(k.querySelector(".full")); s.removeAllRanges(); s.addRange(r);
  });
  document.addEventListener("click", async (ev) => {
    const k = ev.target.closest(".key"); if (!k || ev.detail > 1 || String(window.getSelection())) return;
    try { await navigator.clipboard.writeText(k.title); toast("copied " + k.dataset.short); } catch { /* no clipboard */ }
  });
  // ---- boot ----
  try { await loadInfo(); } catch { renderHeader(); }
  await loadFuel();
  await loadCard();
  me = localStorage.getItem("me");
  if (me && await resumeRemote()) { /* a remote session answers for itself when first used */ }
  else if (me && window.nostr) { try { const pk = await window.nostr.getPublicKey(); if (pk !== me) me = null; } catch { me = null; } }
  else if (me) me = null;
  renderHeader();
  renderApps();
  await loadAdmin();
  await loadPeople();
})();
