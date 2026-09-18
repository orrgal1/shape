import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { uptime } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { repositoryIdentity } from "../../packages/bridge/src/agent/worktrees.ts";
import { shapeHome } from "./client.mjs";

const execFileAsync = promisify(execFile);
const HANDLE_VERSION = 1;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function handlesDirectory() {
  return join(shapeHome(), "live");
}

function assertSessionId(sessionId) {
  if (!SESSION_RE.test(sessionId)) {
    throw new Error(`invalid session handle ${JSON.stringify(sessionId)}`);
  }
}

function handlePath(sessionId) {
  assertSessionId(sessionId);
  return join(handlesDirectory(), `${sessionId}.json`);
}

function lockPath(sessionId) {
  assertSessionId(sessionId);
  return join(handlesDirectory(), `${sessionId}.lock`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHandle(value, sessionId) {
  if (!isRecord(value) || value.version !== HANDLE_VERSION || value.sessionId !== sessionId) {
    throw new Error(`live session handle ${sessionId} is invalid`);
  }
  const repository = value.repository;
  if (
    !isRecord(repository) ||
    typeof repository.id !== "string" ||
    repository.id.length === 0 ||
    typeof repository.label !== "string" ||
    repository.label.length === 0 ||
    typeof repository.path !== "string" ||
    repository.path.length === 0
  ) {
    throw new Error(`live session handle ${sessionId} has an invalid repository identity`);
  }
  if (typeof value.branch !== "string" || !value.branch.startsWith("refs/heads/") || value.branch.length === "refs/heads/".length) {
    throw new Error(`live session handle ${sessionId} has an invalid branch`);
  }
  let server;
  try {
    server = new URL(value.server);
  } catch {
    throw new Error(`live session handle ${sessionId} has an invalid server`);
  }
  if (
    (server.protocol !== "http:" && server.protocol !== "https:") ||
    server.origin !== value.server ||
    server.username !== "" ||
    server.password !== ""
  ) {
    throw new Error(`live session handle ${sessionId} has an invalid server`);
  }
  if (typeof value.createdAt !== "string") {
    throw new Error(`live session handle ${sessionId} has an invalid creation time`);
  }
  if (value.status !== "pending" && value.status !== "active" && value.status !== "stopped") {
    throw new Error(`live session handle ${sessionId} has an invalid lifecycle state`);
  }
  return {
    version: HANDLE_VERSION,
    sessionId,
    repository: { id: repository.id, label: repository.label, path: repository.path },
    branch: value.branch,
    server: value.server,
    createdAt: value.createdAt,
    status: value.status,
  };
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function processStartIdentity(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    const identity = stdout.trim().replace(/\s+/g, " ");
    return identity.length === 0 ? null : identity;
  } catch {
    return null;
  }
}

export async function resolveLiveCheckout(repo = process.cwd(), expectedBranch) {
  const cwd = resolve(repo);
  const repository = await repositoryIdentity(cwd);
  const branch = await git(cwd, ["symbolic-ref", "--quiet", "HEAD"]);
  if (branch === null || !branch.startsWith("refs/heads/")) {
    if (expectedBranch === undefined) {
      throw new Error(
        "detached HEAD cannot identify a live canvas; check out the mapped branch (for example, git switch <branch>) or run from an attached worktree",
      );
    }
    const guidance = expectedBranch.slice("refs/heads/".length);
    throw new Error(
      `detached HEAD cannot identify live session branch ${expectedBranch}; check it out (for example, git switch ${JSON.stringify(guidance)}) or use --repo with an attached worktree on that branch`,
    );
  }
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null || root.length === 0) throw new Error(`${cwd} is not inside a Git worktree`);
  return { repository, branch, root: resolve(root) };
}

export function assertHandleMatchesCheckout(handle, checkout) {
  if (checkout.repository.id !== handle.repository.id) {
    throw new Error(
      `live session ${handle.sessionId} belongs to repository ${handle.repository.label}; run the command from that repository instead of ${checkout.repository.label}`,
    );
  }
  if (checkout.branch !== handle.branch) {
    throw new Error(
      `live session ${handle.sessionId} belongs to branch ${handle.branch}; current branch is ${checkout.branch}. Switch back or use --repo with an attached worktree on the original branch`,
    );
  }
}

export function normalizeReportedFiles(files, root) {
  return files.map((file) => {
    if (typeof file !== "string" || file.trim().length === 0) throw new Error("--files needs a non-empty repository-relative path");
    const normalized = relative(root, resolve(root, file));
    if (normalized === "" || normalized === ".." || normalized.startsWith(`..${sep}`)) {
      throw new Error(`reported file ${JSON.stringify(file)} must be inside the current repository`);
    }
    return normalized.split(sep).join("/");
  });
}

export function createSessionId() {
  return randomUUID();
}

async function syncDirectory(path) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeLiveHandle(handle, exclusive) {
  const dir = handlesDirectory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const destination = handlePath(handle.sessionId);
  const temporary = join(dir, `.${handle.sessionId}.${process.pid}.${randomUUID()}.tmp`);
  const body = `${JSON.stringify({ ...handle, version: HANDLE_VERSION }, null, 2)}\n`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(body, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    if (exclusive) {
      await link(temporary, destination);
      await unlink(temporary);
    } else {
      await rename(temporary, destination);
    }
    await syncDirectory(dir);
  } catch (error) {
    await file?.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function saveLiveHandle(handle) {
  await writeLiveHandle({ ...handle, status: "pending" }, true);
}

export async function updateLiveHandle(handle, status) {
  if (status !== "active" && status !== "stopped") throw new Error(`invalid live session lifecycle state ${status}`);
  const updated = { ...handle, status };
  await writeLiveHandle(updated, false);
  return updated;
}

export async function loadLiveHandle(sessionId, { missing = "error" } = {}) {
  const path = handlePath(sessionId);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      if (missing === "null") return null;
      throw new Error(`unknown live session ${sessionId}; no local handle exists under ${handlesDirectory()}`);
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`live session handle ${sessionId} is not valid JSON`);
  }
  return parseHandle(parsed, sessionId);
}

export async function removeLiveHandle(sessionId) {
  try {
    await unlink(handlePath(sessionId));
    await syncDirectory(handlesDirectory());
  } catch (error) {
    if (error === null || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
}

async function readLiveLock(path) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
  let owner = null;
  try {
    owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
  } catch (error) {
    if (error === null || typeof error !== "object" || (error.code !== "ENOENT" && !(error instanceof SyntaxError))) {
      throw error;
    }
  }
  return { info, owner };
}

async function liveLockIsStale(lock) {
  if (lock === null) return true;
  const { info, owner } = lock;
  const createdAt =
    owner !== null && typeof owner === "object" && typeof owner.createdAt === "string"
      ? Date.parse(owner.createdAt)
      : Number.NaN;
  const bootedAt = Date.now() - uptime() * 1_000;
  if (Number.isFinite(createdAt) && createdAt < bootedAt) return true;
  if (
    owner !== null &&
    typeof owner === "object" &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0
  ) {
    const storedStart = typeof owner.processStartedAt === "string" ? owner.processStartedAt : null;
    const currentStart = await processStartIdentity(owner.pid);
    if (storedStart !== null && currentStart !== null) return storedStart !== currentStart;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return error !== null && typeof error === "object" && error.code === "ESRCH";
    }
  }
  return false;
}

async function createLiveLock(path) {
  const token = randomUUID();
  const temporary = `${path}.new-${token}`;
  try {
    await mkdir(temporary, { mode: 0o700 });
    const owner = await open(join(temporary, "owner.json"), "wx", 0o600);
    const processStartedAt = await processStartIdentity(process.pid);
    try {
      await owner.writeFile(
        `${JSON.stringify({ pid: process.pid, processStartedAt, createdAt: new Date().toISOString(), token })}\n`,
        "utf8",
      );
      await owner.sync();
    } finally {
      await owner.close();
    }
    await syncDirectory(temporary);
    try {
      await rename(temporary, path);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        ["EEXIST", "ENOTEMPTY"].includes(error.code)
      ) {
        const collision = new Error(`live session lock ${path} already exists`);
        collision.code = "EEXIST";
        throw collision;
      }
      throw error;
    }
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function staleLockToken(path, lock) {
  if (
    lock !== null &&
    lock.owner !== null &&
    typeof lock.owner === "object" &&
    typeof lock.owner.token === "string" &&
    SESSION_RE.test(lock.owner.token)
  ) {
    return lock.owner.token;
  }
  throw new Error(
    `live session lock ${path} has no verifiable owner and cannot be recovered automatically; remove it only after confirming no live command owns it`,
  );
}

async function reclaimLiveLock(path) {
  const lock = await readLiveLock(path);
  if (!(await liveLockIsStale(lock))) throw new Error(`live session lock ${path} is held by another command`);
  if (lock === null) return await acquireLiveLock(path);
  const token = await staleLockToken(path, lock);
  const quarantine = `${path}.stale-${token}`;
  try {
    await rename(path, quarantine);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      ["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)
    ) {
      return await acquireLiveLock(path);
    }
    throw error;
  }
  try {
    await createLiveLock(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(`live session lock ${path} was acquired by another command`);
    }
    throw error;
  }
}

async function acquireLiveLock(path) {
  try {
    await createLiveLock(path);
    return;
  } catch (error) {
    if (error === null || typeof error !== "object" || error.code !== "EEXIST") throw error;
  }
  return await reclaimLiveLock(path);
}

export async function withLiveHandleLock(sessionId, action) {
  const dir = handlesDirectory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = lockPath(sessionId);
  await acquireLiveLock(path);
  try {
    return await action();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
