// Disposable GRASP-01 capacity smoke. Provisions one disposable relay, applies
// restrictive limits, proves rejection, raises policy, then proves an
// incremental Git push and clone. A mode-0600 manifest is written before
// network mutation for recovery.
//
// Run: npm run test:git-capacity
// For a local Wrangler relay: CAPACITY_RELAY_URL=http://127.0.0.1:8787 npm run test:git-capacity
// Recover: node scripts/ops/git-capacity.mjs cleanup <manifest.json>
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import { npubEncode } from "nostr-tools/nip19";
import WebSocket from "ws";

const exec = promisify(execFile);
const blobMiB = Number(process.env.CAPACITY_BLOB_MIB ?? 5);
const commits = Number(process.env.CAPACITY_COMMITS ?? 4);
const largeMiB = Number(process.env.CAPACITY_LARGE_MIB ?? 37);
const suppliedRelayURL = process.env.CAPACITY_RELAY_URL;
const timeoutMs = 30_000;
if (!Number.isInteger(blobMiB) || blobMiB < 5 || blobMiB > 32) throw new Error("CAPACITY_BLOB_MIB must be 5..32");
if (!Number.isInteger(commits) || commits < 4 || commits > 32) throw new Error("CAPACITY_COMMITS must be 4..32");
if (!Number.isInteger(largeMiB) || largeMiB < 0 || largeMiB > 128) throw new Error("CAPACITY_LARGE_MIB must be 0..128");

const http = (url) => url.replace(/^ws(s?):\/\//, "http$1://").replace(/\/$/, "");
const ws = (url) => url.replace(/^http(s?):\/\//, "ws$1://").replace(/\/$/, "");
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(url, sk, method, ...params) {
  const endpoint = `${http(url)}/`;
  const payload = { method, params };
  const authorization = await getToken(endpoint, "POST", (event) => finalizeEvent(event, sk), true, payload);
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization }, body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000) });
  const body = await response.json();
  if (!response.ok || body.error || body.result?.error) throw new Error(String(body.error ?? body.result?.error ?? `RPC ${response.status}`));
  return body.result;
}

async function saveManifest(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function git(cwd, ...args) {
  const result = await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 1024 * 1024, timeout: 300_000 });
  return result.stdout.trim();
}

const repositoryPath = (npub, identifier) => `/${npub}/${encodeURIComponent(identifier)}.git`;
const event = (sk, kind, tags, content = "", createdAt = now()) => finalizeEvent({ kind, tags, content, created_at: createdAt }, sk);

async function publish(url, sk, value) {
  const socket = new WebSocket(ws(url));
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out publishing event")), timeoutMs);
      socket.on("message", (raw) => { const message = JSON.parse(raw.toString()); if (message[0] === "OK" && message[1] === value.id) { clearTimeout(timer); resolve(message); } });
      socket.send(JSON.stringify(["EVENT", value]));
    });
    if (!result[2]) throw new Error(`event rejected: ${result[3] ?? "unknown relay error"}`);
  } finally { socket.close(); }
}

async function waitForRepository(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${url}/info/refs?service=git-upload-pack`);
    const text = await response.text();
    if (response.status === 200 && text.includes("# service=git-upload-pack")) return;
    await sleep(250);
  }
  throw new Error("repository did not become available");
}

async function assertNoMainRef(url) {
  const response = await fetch(`${url}/info/refs?service=git-upload-pack`);
  if (/[0-9a-f]{40} refs\/heads\/main(?:\x00|\n)/.test(await response.text())) throw new Error("rejected push advanced refs");
}

async function announce(url, sk, repoURL, identifier, tip, createdAt) {
  await publish(url, sk, event(sk, 30617, [["d", identifier], ["clone", repoURL], ["relays", ws(url)], ["maintainers", getPublicKey(sk)]], "", createdAt));
  await publish(url, sk, event(sk, 30618, [["d", identifier], ["HEAD", "ref: refs/heads/main"], ["refs/heads/main", tip]], "", createdAt + 1));
}

async function createHistory(root) {
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.email", "capacity-smoke@example.invalid");
  await git(root, "config", "user.name", "bind.ws capacity smoke");
  for (let index = 1; index <= commits; index++) {
    await writeFile(`${root}/payload-${index}.bin`, randomBytes(blobMiB * 1024 * 1024));
    await git(root, "add", ".");
    await git(root, "commit", "-m", `capacity fixture ${index}`);
  }
  if (largeMiB) {
    await writeFile(`${root}/large-payload.bin`, randomBytes(largeMiB * 1024 * 1024));
    await git(root, "add", ".");
    await git(root, "commit", "-m", `capacity fixture ${largeMiB} MiB object`);
  }
}

async function pushHistory(root, repoURL, url, sk, identifier, createdAt, stopAfter) {
  const tips = (await git(root, "rev-list", "--reverse", "HEAD")).split("\n").filter(Boolean);
  for (const [index, tip] of tips.entries()) {
    if (index >= stopAfter) break;
    await publish(url, sk, event(sk, 30618, [["d", identifier], ["HEAD", "ref: refs/heads/main"], ["refs/heads/main", tip]], "", createdAt + 2 + index));
    await git(root, "push", repoURL, `${tip}:refs/heads/main`);
  }
}

const LOW_GIT = { maxRepositories: 16, maxRelayBytes: 320 * 1024 * 1024, maxPackBytes: 4 * 1024 * 1024, maxObjectBytes: 4 * 1024 * 1024, maxObjects: 4096, maxRawBytes: 16 * 1024 * 1024, maxTransactionRawBytes: 16 * 1024 * 1024, maxTransactionObjects: 4096, maxCompressedBytes: 16 * 1024 * 1024, maxMetadataBytes: 16 * 1024 * 1024, maxRefs: 1024, maxGraphEdges: 65536, maxFetchBytes: 16 * 1024 * 1024 };
const HIGH_GIT = { maxRepositories: 128, maxRelayBytes: 6 * 1024 * 1024 * 1024, maxPackBytes: 95 * 1024 * 1024, maxObjectBytes: 64 * 1024 * 1024, maxObjects: 100000, maxRawBytes: 64 * 1024 * 1024 * 1024, maxTransactionRawBytes: 64 * 1024 * 1024, maxTransactionObjects: 20000, maxCompressedBytes: 6 * 1024 * 1024 * 1024, maxMetadataBytes: 1024 * 1024 * 1024, maxRefs: 4096, maxGraphEdges: 1000000, maxFetchBytes: 6 * 1024 * 1024 * 1024 };
function assertGitPolicy(policy, expected, label) {
  for (const [key, value] of Object.entries(expected)) if (policy?.git?.[key] !== value) throw new Error(`${label} policy did not apply ${key}`);
}

async function cleanupManifest(path) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (!manifest?.url || !manifest?.secret || !manifest?.slug || !/^(?:[a-z0-9-]+\.bind\.ws|localhost|127\.0\.0\.1)$/.test(new URL(manifest.url).hostname)) throw new Error("invalid capacity manifest");
  const sk = Uint8Array.from(Buffer.from(manifest.secret, "hex"));
  const policy = await rpc(manifest.url, sk, "getpolicy");
  if (policy.owner !== getPublicKey(sk)) throw new Error("capacity manifest owner mismatch");
  const result = await rpc(manifest.url, sk, "deleterelay", manifest.slug);
  if (result?.deleted !== true) throw new Error("relay deletion was not acknowledged");
  await rm(path, { force: true });
  console.log("capacity relay deleted");
}

async function main() {
  if (process.argv[2] === "cleanup") {
    if (!process.argv[3] || process.argv[4]) throw new Error("usage: git-capacity.mjs cleanup <manifest.json>");
    return cleanupManifest(process.argv[3]);
  }
  if (process.argv[2]) throw new Error("usage: git-capacity.mjs [cleanup <manifest.json>]");
  const root = await mkdtemp(`${tmpdir()}/bindws-capacity-root-`);
  const clone = await mkdtemp(`${tmpdir()}/bindws-capacity-clone-`);
  const sk = generateSecretKey();
  const owner = npubEncode(getPublicKey(sk));
  const identifier = `capacity-${randomBytes(6).toString("hex")}`;
  const slug = suppliedRelayURL ? (process.env.CAPACITY_RELAY_SLUG ?? "dev-capacity") : `capacity-${randomBytes(6).toString("hex")}`;
  const url = suppliedRelayURL ?? `https://${slug}.bind.ws`;
  const manifestRoot = join(homedir(), ".local", "share", "bindws", "git-capacity-tests", slug);
  const manifestPath = join(manifestRoot, "manifest.json");
  await mkdir(manifestRoot, { recursive: true, mode: 0o700 });
  const manifest = { version: 1, slug, url, secret: Buffer.from(sk).toString("hex"), identifier, state: "planned" };
  await saveManifest(manifestPath, manifest);
  const repoURL = `${http(url)}${repositoryPath(owner, identifier)}`;
  const createdAt = now();
  try {
    const claimed = await rpc(url, sk, "claim");
    if (!claimed?.claimed || claimed.owner !== getPublicKey(sk)) throw new Error("capacity relay claim failed");
    manifest.state = "claimed";
    await saveManifest(manifestPath, manifest);
    await rpc(url, sk, "setpolicy", { reads: "open", features: { grasp: true }, git: LOW_GIT });
    assertGitPolicy(await rpc(url, sk, "getpolicy"), LOW_GIT, "restrictive");
    await createHistory(root);
    const tips = (await git(root, "rev-list", "--reverse", "HEAD")).split("\n").filter(Boolean);
    await announce(url, sk, repoURL, identifier, tips[0], createdAt);
    await waitForRepository(repoURL);
    let rejected = false;
    try { await pushHistory(root, repoURL, url, sk, identifier, createdAt, 1); } catch { rejected = true; }
    if (!rejected) throw new Error("restrictive policy accepted the over-capacity push");
    await assertNoMainRef(repoURL);
    await rpc(url, sk, "setpolicy", { git: HIGH_GIT });
    assertGitPolicy(await rpc(url, sk, "getpolicy"), HIGH_GIT, "raised");
    await pushHistory(root, repoURL, url, sk, identifier, createdAt, commits + (largeMiB ? 1 : 0));
    await waitForRepository(repoURL);
    await git(clone, "clone", repoURL, ".");
    await git(clone, "fsck", "--full");
    await git(clone, "bundle", "create", "capacity-backup.bundle", "--all");
    await git(clone, "bundle", "verify", "capacity-backup.bundle");
    const expected = await git(root, "rev-parse", "HEAD");
    if (await git(clone, "rev-parse", "HEAD") !== expected) throw new Error("raised-policy clone did not reach expected tip");
    const sample = await readFile(`${clone}/${largeMiB ? "large-payload.bin" : `payload-${commits}.bin`}`);
    const expectedBytes = (largeMiB || blobMiB) * 1024 * 1024;
    if (sample.length !== expectedBytes) throw new Error("raised-policy clone has truncated content");
    console.log(`PASS: restrictive policy rejected >${blobMiB} MiB; raised policy stored ${commits} x ${blobMiB} MiB${largeMiB ? ` plus ${largeMiB} MiB` : ""} and cloned cleanly`);
  } finally {
    try {
      await cleanupManifest(manifestPath);
      await rm(manifestRoot, { recursive: true, force: true });
    } catch (error) {
      console.error(`Cleanup requires recovery using ${manifestPath}: ${error.message}`);
      process.exitCode = 1;
    }
    await Promise.all([rm(root, { recursive: true, force: true }), rm(clone, { recursive: true, force: true })]);
  }
}

main().catch((error) => { console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
