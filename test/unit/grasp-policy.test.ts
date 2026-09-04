import { describe, expect, it } from "vitest";
import {
  eventReferencesRepository,
  gitRepositoryPath,
  isCanonicalCloneURL,
  isWebSocketURL,
  latestState,
  nostrRefEventID,
  parseRepositoryAnnouncement,
  parseRepositoryState,
  recursiveMaintainers,
  repositoryCoordinate,
  serviceListed,
  stateAllowsRefs,
} from "../../src/grasp-policy.ts";

const owner = "a".repeat(64);
const maintainer = "b".repeat(64);
const eventID = "c".repeat(64);
const base = { id: eventID, pubkey: owner, kind: 30617, created_at: 10, tags: [] as string[][] };

describe("GRASP-01 policy", () => {
  it("parses and validates repository announcements", () => {
    const parsed = parseRepositoryAnnouncement({ ...base, tags: [["d", "bindws"], ["clone", "https://git.example/bindws.git", "ssh://git.example/bindws"], ["relays", "wss://relay.example", "ws://localhost:8787"], ["maintainers", maintainer]] });
    expect(parsed.error).toBeUndefined();
    expect(parsed.value?.maintainers).toEqual([maintainer]);
    expect(repositoryCoordinate(parsed.value!)).toBe(`30617:${owner}:bindws`);
    expect(serviceListed(parsed.value!, "https://git.example/bindws.git", "wss://relay.example/")).toBe(true);
  });

  it("accepts third-party clone schemes and rejects malformed relay URLs", () => {
    expect(isCanonicalCloneURL("http://git.example/x.git")).toBe(true);
    expect(isCanonicalCloneURL("ssh://git.example/x")).toBe(true);
    expect(isCanonicalCloneURL("git@git.example:x")).toBe(true);
    expect(isCanonicalCloneURL("nostr://danconwaydev.com/relay.ngit.dev/ngit")).toBe(true);
    expect(isWebSocketURL("https://relay.example")).toBe(false);
    expect(parseRepositoryAnnouncement({ ...base, tags: [["d", "x"], ["clone", "https://git.example/x.git"], ["relays", "https://relay.example"]] }).error).toContain("relays");
  });

  it("preserves identifiers through the percent-encoded Git path", () => {
    expect(gitRepositoryPath("npub1example", "my/repo repo")).toBe("/npub1example/my%2Frepo%20repo.git");
    expect(gitRepositoryPath("npub1example", "a!b'c(d)*~")).toBe("/npub1example/a%21b%27c%28d%29%2A~.git");
    expect(() => gitRepositoryPath("hex", "x")).toThrow();
  });

  it("uses the 256-byte identifier quota and rejects lone surrogates", () => {
    expect(() => gitRepositoryPath("npub1example", "a".repeat(257))).toThrow();
    expect(() => gitRepositoryPath("npub1example", "\ud800")).toThrow();
    expect(parseRepositoryAnnouncement({ ...base, tags: [["d", "a".repeat(257)], ["clone", "https://git.example/x.git"], ["relays", "wss://relay.example"]] }).error).toContain("identifier");
  });

  it("rejects duplicate d tags but accepts multi-value tags", () => {
    const duplicate = parseRepositoryAnnouncement({ ...base, tags: [["d", "one"], ["d", "two"], ["clone", "http://git.example/x.git"], ["relays", "ws://relay.example"]] });
    expect(duplicate.error).toContain("identifier");
    const multi = parseRepositoryAnnouncement({ ...base, tags: [["d", "my/repo"], ["clone", "http://git.example/x.git", "ssh://git.example/x"], ["relays", "ws://relay.example", "wss://relay.example"]] });
    expect(multi.value?.clone).toHaveLength(2);
    expect(multi.value?.relays).toHaveLength(2);
  });

  it("walks recursive maintainers with cycles", () => {
    const root = { id: eventID, owner, identifier: "x", clone: [], relays: [], maintainers: [maintainer], private: false };
    const second = { ...root, id: "d".repeat(64), owner: maintainer, maintainers: ["e".repeat(64)] };
    const third = { ...root, id: "e".repeat(64), owner: "e".repeat(64), maintainers: [owner] };
    expect(recursiveMaintainers(root, [second, third])).toEqual(new Set([owner, maintainer, "e".repeat(64)]));
  });

  it("parses state and compares refs exactly", () => {
    const state = parseRepositoryState({ id: eventID, pubkey: owner, kind: 30618, created_at: 12, tags: [["d", "x"], ["refs/heads/main", "1".repeat(40)], ["HEAD", "ref: refs/heads/main"], ["refs/tags/v1^{}", "2".repeat(40)]] });
    expect(state.error).toBeUndefined();
    expect(state.value?.refs).toEqual({ "refs/heads/main": "1".repeat(40) });
    expect(state.value && stateAllowsRefs(state.value, { "refs/heads/main": "1".repeat(40) }, "refs/heads/main")).toBe(true);
    expect(state.value && stateAllowsRefs(state.value, {}, null)).toBe(false);
  });

  it("rejects unsafe refs and zero object IDs", () => {
    for (const ref of ["refs/heads/a..b", "refs/heads/a@{b}", "refs/heads/a.lock", "refs/heads/a//b", "refs/heads/a~b"]) {
      expect(parseRepositoryState({ id: eventID, pubkey: owner, kind: 30618, created_at: 12, tags: [["d", "x"], [ref, "1".repeat(40)]] }).error).toContain("ref");
    }
    expect(parseRepositoryState({ id: eventID, pubkey: owner, kind: 30618, created_at: 12, tags: [["d", "x"], ["refs/heads/main", "0".repeat(40)]] }).error).toContain("ref");
  });

  it("orders state ties by the lower event id and filters authors", () => {
    const make = (id: string, created_at: number, author = owner) => ({ id, owner: author, created_at, identifier: "x", refs: {}, head: null });
    const states = [make("f".repeat(64), 20), make("e".repeat(64), 20), make("0".repeat(64), 21, "z".repeat(64))];
    expect(latestState(states, owner, "x", new Set([maintainer]))?.id).toBe("e".repeat(64));
  });

  it("recognizes unknown PR refs without requiring a stored event", () => {
    expect(nostrRefEventID(`refs/nostr/${eventID}`)).toBe(eventID);
    expect(nostrRefEventID("refs/heads/main")).toBeNull();
  });

  it("matches valid repository a-tags only", () => {
    const coordinate = `30617:${owner}:x`;
    expect(eventReferencesRepository({ ...base, kind: 1618, tags: [["a", coordinate]] }, coordinate)).toBe(true);
    expect(eventReferencesRepository({ ...base, kind: 1618, tags: [["a", "30618:" + owner + ":x"]] }, coordinate)).toBe(false);
  });

  it("fails closed when recursive maintainers exceed the bound", () => {
    const root = { id: eventID, owner, identifier: "x", clone: [], relays: [], maintainers: [maintainer], private: false };
    expect(recursiveMaintainers(root, [], 8, 1)).toBeNull();
  });
});
