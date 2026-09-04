// GRASP-01 conformance uses the stock Git client against the public Smart HTTP door.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { finalizeEvent, getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { KIND_REPO, KIND_REPO_STATE } from "../../src/kinds.ts";
import { Client, HTTP_URL, RELAY_URL, sleep, now } from "./helpers.ts";
import { npubEncode } from "nostr-tools/nip19";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return result.stdout.trim();
}

function repositoryPath(npub: string, identifier: string): string {
  return `/${npub}/${encodeURIComponent(identifier)}.git`;
}

async function waitForRefs(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${url}/info/refs?service=git-upload-pack`);
    const text = await response.text();
    if (response.status === 200 && text.includes("# service=git-upload-pack")) return;
    await sleep(250);
  }
  throw new Error("GRASP repository did not become available");
}

async function publish(c: Client, sk: Uint8Array, kind: number, tags: string[][], createdAt: number): Promise<void> {
  const event = finalizeEvent({ kind, content: "", tags, created_at: createdAt }, sk);
  await c.publish(event);
}

describe("GRASP-01 stock Git", () => {
  it("clones, pushes an accepted state, fetches incrementally, and supports partial clones", async ({ skip }) => {
    const infoResponse = await fetch(HTTP_URL, { headers: { accept: "application/nostr+json" } });
    const info: any = await infoResponse.json();
    if (!info.supported_grasps?.includes("GRASP-01")) skip();

    const root = await mkdtemp(`${tmpdir()}/bindws-grasp-`);
    const clone = await mkdtemp(`${tmpdir()}/bindws-grasp-clone-`);
    const partial = await mkdtemp(`${tmpdir()}/bindws-grasp-partial-`);
    const sk = generateSecretKey();
    const npub = npubEncode(getPublicKey(sk));
    const identifier = `stock-${Math.random().toString(36).slice(2, 10)}`;
    const path = repositoryPath(npub, identifier);
    const repoURL = `${HTTP_URL}${path}`;
    const relayURL = RELAY_URL;
    const createdAt = now();
    const c = await Client.connect(RELAY_URL);
    try {
      await git(root, "init", "--initial-branch=main");
      await git(root, "config", "user.email", "grasp-conformance@example.com");
      await git(root, "config", "user.name", "GRASP conformance");
      await writeFile(`${root}/README.md`, "initial GRASP repository\n");
      await git(root, "add", "README.md");
      await git(root, "commit", "-m", "initial");
      const first = await git(root, "rev-parse", "HEAD");
      await git(root, "tag", "-a", "v1", "-m", "first release");
      const tag = await git(root, "rev-parse", "refs/tags/v1^{tag}");

      await publish(c, sk, KIND_REPO, [
        ["d", identifier],
        ["clone", repoURL],
        ["relays", relayURL],
        ["maintainers", getPublicKey(sk)],
      ], createdAt);
      await publish(c, sk, KIND_REPO_STATE, [
        ["d", identifier],
        ["HEAD", "ref: refs/heads/main"],
        ["refs/heads/main", first],
        ["refs/tags/v1", tag],
      ], createdAt + 1);

      await waitForRefs(repoURL);
      await git(root, "push", repoURL, "HEAD:refs/heads/main", "refs/tags/v1:refs/tags/v1");
      await git(clone, "clone", repoURL, ".");
      expect(await git(clone, "rev-parse", "HEAD")).toBe(first);
      expect(await git(clone, "describe", "--tags")).toBe("v1");
      expect((await git(clone, "fsck", "--full"))).not.toContain("dangling");

      await writeFile(`${root}/README.md`, "incremental GRASP repository\n");
      await git(root, "add", "README.md");
      await git(root, "commit", "-m", "incremental");
      const second = await git(root, "rev-parse", "HEAD");
      await publish(c, sk, KIND_REPO_STATE, [
        ["d", identifier],
        ["HEAD", "ref: refs/heads/main"],
        ["refs/heads/main", second],
        ["refs/tags/v1", tag],
      ], createdAt + 2);
      await git(root, "push", repoURL, "HEAD:refs/heads/main");
      await git(clone, "fetch", repoURL, "refs/heads/main:refs/remotes/origin/main");
      expect(await git(clone, "rev-parse", "refs/remotes/origin/main")).toBe(second);

      await git(partial, "clone", "--filter=blob:none", "--no-checkout", repoURL, ".");
      await git(partial, "fsck", "--full");
      await git(partial, "checkout", "main");
      expect(await readFile(`${partial}/README.md`, "utf8")).toBe("incremental GRASP repository\n");
    } finally {
      await publish(c, sk, 5, [["a", `${KIND_REPO}:${getPublicKey(sk)}:${identifier}`], ["a", `${KIND_REPO_STATE}:${getPublicKey(sk)}:${identifier}`]], createdAt + 3).catch(() => {});
      c.close();
      await Promise.all([rm(root, { recursive: true, force: true }), rm(clone, { recursive: true, force: true }), rm(partial, { recursive: true, force: true })]);
    }
  }, 120_000);
});
