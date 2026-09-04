// Callback policy shared by configuration and delivery. The host's trusted
// origins and the relay owner's origins intersect; neither list is a URL proxy.
export function callbackOrigin(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048) return "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.hash || u.port) return "";
    const h = u.hostname;
    // Only ordinary public DNS names. DNS ownership is trusted explicitly
    // by the host operator, not delegated to relay members or tenants.
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(h)) return "";
    if (/\.(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(h)) return "";
    return u.origin;
  } catch { return ""; }
}

export function callbackOrigins(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 16) return null;
  const out: string[] = [];
  for (const value of raw) {
    const origin = callbackOrigin(value);
    if (!origin || (value !== origin && value !== origin + "/")) return null;
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}
