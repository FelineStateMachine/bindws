// Retained Git capacity is separate from the work admitted in one request.
// Values are bytes (not decimal MB); the console presents MiB/GiB.
export interface GitLimits {
  maxRepositories: number;
  maxRelayBytes: number;
  maxPackBytes: number;
  maxObjectBytes: number;
  maxObjects: number;
  maxRawBytes: number;
  maxTransactionRawBytes: number;
  maxTransactionObjects: number;
  maxCompressedBytes: number;
  maxMetadataBytes: number;
  maxRefs: number;
  maxGraphEdges: number;
  maxFetchBytes: number;
}

export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

export const DEFAULT_GIT_LIMITS: Readonly<GitLimits> = Object.freeze({
  maxRepositories: 128,
  maxRelayBytes: 2 * GiB,
  maxPackBytes: 16 * MiB,
  maxObjectBytes: 16 * MiB,
  maxObjects: 100_000,
  maxRawBytes: 4 * GiB,
  maxTransactionRawBytes: 32 * MiB,
  maxTransactionObjects: 20_000,
  maxCompressedBytes: GiB,
  maxMetadataBytes: 128 * MiB,
  maxRefs: 4096,
  maxGraphEdges: 1_000_000,
  maxFetchBytes: 2 * GiB,
});

// Keep headroom under the 10 GiB physical SQLite database ceiling. Request
// bounds are independent of that allowance and remain subject to memory/CPU.
export const MAX_GIT_LIMITS: Readonly<GitLimits> = Object.freeze({
  maxRepositories: 4096,
  maxRelayBytes: 6 * GiB,
  maxPackBytes: 95 * MiB,
  maxObjectBytes: 64 * MiB,
  maxObjects: 500_000,
  maxRawBytes: 64 * GiB,
  maxTransactionRawBytes: 64 * MiB,
  maxTransactionObjects: 100_000,
  maxCompressedBytes: 6 * GiB,
  maxMetadataBytes: GiB,
  maxRefs: 16_384,
  maxGraphEdges: 4_000_000,
  maxFetchBytes: 6 * GiB,
});

// Reject a malformed patch as a unit rather than silently accepting a typo
// or making an owner believe a higher limit was applied. Empty patches are
// valid, and omitted fields preserve the current relay's choices.
export function gitLimitPatch(raw: unknown, current: Readonly<GitLimits> = DEFAULT_GIT_LIMITS): GitLimits | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const next = { ...current };
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(MAX_GIT_LIMITS, key)) return undefined;
    const field = key as keyof GitLimits;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GIT_LIMITS[field]) return undefined;
    next[field] = value;
  }
  return next;
}

export function gitPackLimits(limits: Readonly<GitLimits>) {
  return {
    maxPackBytes: limits.maxPackBytes,
    maxObjectBytes: limits.maxObjectBytes,
    maxTotalObjectBytes: limits.maxTransactionRawBytes,
    maxObjects: limits.maxTransactionObjects,
    maxPacks: 1,
    maxTotalPackBytes: limits.maxPackBytes,
  };
}

// Lower intake quotas without stranding objects already stored under a larger
// policy. Fetch still has its own explicit response-byte limit and platform
// object/graph bounds; the backend enforces current quotas on each new write.
export function gitHttpLimits(limits: Readonly<GitLimits>) {
  return {
    maxBodyBytes: limits.maxPackBytes + 256 * 1024,
    maxResponseBytes: limits.maxFetchBytes,
    maxRefs: MAX_GIT_LIMITS.maxRefs,
    maxObjects: MAX_GIT_LIMITS.maxObjects,
    maxGraphEdges: MAX_GIT_LIMITS.maxGraphEdges,
    gitLimits: gitPackLimits(limits),
    fetchLimits: {
      maxPackBytes: limits.maxFetchBytes,
      maxObjectBytes: MAX_GIT_LIMITS.maxObjectBytes,
      maxTotalObjectBytes: MAX_GIT_LIMITS.maxRawBytes,
      maxObjects: MAX_GIT_LIMITS.maxObjects,
      maxPacks: 1,
      maxTotalPackBytes: limits.maxFetchBytes,
    },
  };
}
