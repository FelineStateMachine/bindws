// Pure GRASP-01 policy helpers. Runtime code supplies accepted events and
// applies the returned decisions to the relay and Git object store.

import { KIND_REPO, KIND_REPO_STATE } from "./kinds.ts";

export interface GraspEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
}

export interface RepositoryAnnouncement {
  id: string;
  owner: string;
  identifier: string;
  clone: string[];
  relays: string[];
  maintainers: string[];
  private: boolean;
}

export interface RepositoryState {
  id: string;
  owner: string;
  created_at: number;
  identifier: string;
  refs: Record<string, string>;
  head: string | null;
}

export interface ParseResult<T> {
  value?: T;
  error?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const UTF8 = new TextEncoder();

const identifierBytes = (identifier: string): Uint8Array | null => {
  if (!identifier || identifier === "." || identifier === "..") return null;
  for (let i = 0; i < identifier.length; i++) {
    const code = identifier.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= identifier.length || identifier.charCodeAt(i + 1) < 0xdc00 || identifier.charCodeAt(i + 1) > 0xdfff) return null;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return null;
  }
  for (const character of identifier) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return null;
  }
  const bytes = UTF8.encode(identifier);
  return bytes.length <= 256 ? bytes : null;
};

const validIdentifier = (identifier: string): boolean => identifierBytes(identifier) !== null;

const values = (event: GraspEvent, name: string): string[] => event.tags.filter((tag) => tag[0] === name).flatMap((tag) => tag.slice(1)).filter((value): value is string => typeof value === "string");

const singleton = (event: GraspEvent, name: string): string | null => {
  const tags = event.tags.filter((tag) => tag[0] === name);
  if (tags.length !== 1 || tags[0].length !== 2) return null;
  return tags[0][1] ?? null;
};

const validRef = (ref: string): boolean => {
  if (!ref.startsWith("refs/heads/") && !ref.startsWith("refs/tags/")) return false;
  if (ref.length <= "refs/heads/".length || ref.includes("..") || ref.includes("@{") || ref === "@") return false;
  if (/[\u0000-\u0020\u007f~^:?*[\\]/u.test(ref) || ref.endsWith("/") || ref.endsWith(".") || ref.includes("//")) return false;
  return ref.split("/").every((part) => part !== "." && part !== ".." && !part.endsWith(".lock"));
};

// parseRepositoryAnnouncement extracts the NIP-34 repository record and
// rejects malformed identifiers, URLs, keys, and duplicate singleton tags.
export function parseRepositoryAnnouncement(event: GraspEvent): ParseResult<RepositoryAnnouncement> {
  if (event.kind !== KIND_REPO) return { error: "invalid: expected kind 30617" };
  if (!HEX64.test(event.id) || !HEX64.test(event.pubkey)) return { error: "invalid: bad event identity" };
  const identifier = singleton(event, "d");
  if (identifier === null || !validIdentifier(identifier)) return { error: "invalid: bad repository identifier" };
  const clone = values(event, "clone");
  const relays = values(event, "relays");
  if (clone.length === 0 || clone.some((url) => !isCanonicalCloneURL(url))) return { error: "invalid: bad clone URL" };
  if (relays.some((url) => !isWebSocketURL(url))) return { error: "invalid: relays must be WebSocket URLs" };
  const maintainers = [...new Set(values(event, "maintainers"))];
  if (maintainers.some((key) => !HEX64.test(key))) return { error: "invalid: bad maintainer pubkey" };
  return { value: { id: event.id, owner: event.pubkey, identifier, clone, relays, maintainers, private: values(event, "private").includes("true") } };
}

// isCanonicalCloneURL accepts standard NIP-34 Git clone URL schemes. The
// service-specific HTTPS URL is checked separately by serviceListed.
export function isCanonicalCloneURL(raw: string): boolean {
  try {
    const url = new URL(raw);
    return ["https:", "http:", "ssh:", "git:"].includes(url.protocol) && !url.hash && !!url.hostname;
  } catch {
    return /^git@[^:]+:.+$/u.test(raw);
  }
}

// isWebSocketURL validates a relay URL without allowing credentials or
// fragments that would make service matching ambiguous.
export function isWebSocketURL(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "wss:" || url.protocol === "ws:") && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

// serviceListed checks the exact clone and relay URLs advertised by a
// repository, after URL normalization that ignores a trailing slash only.
export function serviceListed(announcement: RepositoryAnnouncement, cloneURL: string, relayURL: string): boolean {
  return announcement.clone.some((url) => normalizeURL(url) === normalizeURL(cloneURL)) && announcement.relays.some((url) => normalizeURL(url) === normalizeURL(relayURL));
}

const normalizeURL = (raw: string): string => {
  try {
    const url = new URL(raw);
    url.pathname = url.pathname.replace(/\/$/u, "");
    return url.href;
  } catch {
    return raw;
  }
};

// repositoryCoordinate returns the NIP-34 address used by a and q tags.
export function repositoryCoordinate(announcement: Pick<RepositoryAnnouncement, "owner" | "identifier">): string {
  return `30617:${announcement.owner}:${announcement.identifier}`;
}

// gitRepositoryPath constructs the GRASP HTTP path. The caller supplies the
// npub because key encoding belongs at the transport boundary.
export function gitRepositoryPath(npub: string, identifier: string): string {
  const bytes = identifierBytes(identifier);
  if (!npub.startsWith("npub1") || !bytes) throw new Error("invalid repository path");
  let encoded = "";
  for (const byte of bytes) {
    const character = String.fromCharCode(byte);
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || "-._~".includes(character)) encoded += character;
    else encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `/${npub}/${encoded}.git`;
}

// parseRepositoryState parses the exact ref vocabulary defined by NIP-34.
export function parseRepositoryState(event: GraspEvent): ParseResult<RepositoryState> {
  if (event.kind !== KIND_REPO_STATE) return { error: "invalid: expected kind 30618" };
  if (!HEX64.test(event.id) || !HEX64.test(event.pubkey)) return { error: "invalid: bad event identity" };
  const identifier = singleton(event, "d");
  if (identifier === null || !validIdentifier(identifier)) return { error: "invalid: bad repository identifier" };
  const refs: Record<string, string> = {};
  let head: string | null = null;
  for (const tag of event.tags) {
    if (tag[0] === "HEAD") {
      if (head !== null || tag.length !== 2 || !tag[1]?.startsWith("ref: ") || !validRef(tag[1].slice(5))) return { error: "invalid: bad HEAD" };
      head = tag[1].slice(5);
    } else if (tag[0]?.startsWith("refs/")) {
      if (tag[0].endsWith("^{}")) continue;
      if (!validRef(tag[0]) || !tag[1] || !SHA1.test(tag[1]) || /^0+$/u.test(tag[1]) || refs[tag[0]]) return { error: "invalid: bad or duplicate ref" };
      refs[tag[0]] = tag[1];
    }
  }
  return { value: { id: event.id, owner: event.pubkey, created_at: event.created_at, identifier, refs, head } };
}

// recursiveMaintainers computes the bounded fixed point of maintainer
// announcements. A maintainer can extend the set only through its own record.
export function recursiveMaintainers(root: RepositoryAnnouncement, announcements: RepositoryAnnouncement[], maxDepth = 8, maxMaintainers = 64): Set<string> | null {
  const result = new Set<string>([root.owner, ...root.maintainers]);
  if (result.size > maxMaintainers) return null;
  let frontier = new Set<string>([root.owner, ...root.maintainers]);
  for (let depth = 0; depth < maxDepth && frontier.size > 0 && result.size < maxMaintainers; depth++) {
    const next = new Set<string>();
    for (const author of frontier) {
      for (const announcement of announcements) {
        if (announcement.owner !== author || announcement.identifier !== root.identifier) continue;
        for (const maintainer of announcement.maintainers) {
          if (!result.has(maintainer)) {
            if (result.size >= maxMaintainers) return null;
            result.add(maintainer); next.add(maintainer);
          }
        }
      }
    }
    frontier = next;
  }
  return result;
}

// latestState applies NIP-34 addressable-event ordering: newest timestamp,
// then lexicographically smallest event ID for an exact timestamp tie.
export function latestState(events: RepositoryState[], owner: string, identifier: string, maintainers: Set<string>): RepositoryState | null {
  return events.filter((state) => state.identifier === identifier && (state.owner === owner || maintainers.has(state.owner))).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}

// stateAllowsRefs requires the post-push ref map and HEAD to equal the
// accepted state event exactly.
export function stateAllowsRefs(state: RepositoryState, refs: Record<string, string>, head: string | null): boolean {
  const keys = Object.keys(refs);
  const expected = Object.keys(state.refs);
  return head === state.head && keys.length === expected.length && expected.every((key) => refs[key] === state.refs[key]);
}

// nostrRefEventID validates the GRASP PR ref namespace. Unknown event IDs are
// intentionally syntactically valid; the runtime may hold them briefly.
export function nostrRefEventID(ref: string): string | null {
  const match = /^refs\/nostr\/([0-9a-f]{64})$/u.exec(ref);
  return match?.[1] ?? null;
}

// relatedRepositoryCoordinates lists valid NIP-34 repository a-tags.
export function relatedRepositoryCoordinates(event: GraspEvent): string[] {
  return values(event, "a").filter((coordinate) => {
    const parts = coordinate.split(":");
    return parts.length >= 3 && parts[0] === "30617" && HEX64.test(parts[1]) && validIdentifier(parts.slice(2).join(":"));
  });
}

// eventReferencesRepository checks whether an event is anchored to a repo.
export function eventReferencesRepository(event: GraspEvent, coordinate: string): boolean {
  return relatedRepositoryCoordinates(event).includes(coordinate);
}
