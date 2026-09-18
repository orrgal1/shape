import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, readlink, realpath, rm } from "node:fs/promises";
import path from "node:path";

const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function gitResult(cwd, args, { input, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) => {
        const result = { ok: error === null, stdout, stderr, error };
        if (error === null || allowFailure) {
          resolve(result);
          return;
        }
        const detail = stderr.trim() || error.message;
        reject(new Error(`git ${args[0] ?? "command"} failed: ${detail}`));
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}


export async function repositoryRoot(cwd) {
  const result = await gitResult(cwd, ["rev-parse", "--show-toplevel"]);
  const root = result.stdout.trim();
  if (root.length === 0) throw new Error(`${cwd} is not inside a Git repository`);
  return realpath(root);
}

export async function resolveLocalBranch(repoRoot, requested = "main") {
  const value = requested.trim();
  if (value.length === 0) throw new Error("branch must not be empty");
  const branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
  if (branch.length === 0 || value.startsWith("refs/") && !value.startsWith("refs/heads/")) {
    throw new Error(`expected a local branch name or refs/heads/... ref, got ${requested}`);
  }
  const valid = await gitResult(repoRoot, ["check-ref-format", "--branch", branch], { allowFailure: true });
  if (!valid.ok) throw new Error(`invalid local branch ${requested}`);

  const ref = `refs/heads/${branch}`;
  const found = await gitResult(repoRoot, ["show-ref", "--verify", "--hash", ref], { allowFailure: true });
  const commit = found.stdout.trim();
  if (!found.ok || !OID_RE.test(commit)) throw new Error(`local branch ${ref} does not exist`);
  const resolved = (await gitResult(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`])).stdout.trim();
  if (!OID_RE.test(resolved)) throw new Error(`local branch ${ref} does not resolve to a commit`);
  return { branch: ref, ref, commit: resolved };
}

export async function branchTip(repoRoot, ref) {
  const result = await gitResult(repoRoot, ["show-ref", "--verify", "--hash", ref], { allowFailure: true });
  const commit = result.stdout.trim();
  return result.ok && OID_RE.test(commit) ? commit : null;
}

async function checkpointIsAncestor(repoRoot, checkpoint, tip) {
  if (!OID_RE.test(checkpoint)) return false;
  const object = await gitResult(repoRoot, ["cat-file", "-e", `${checkpoint}^{commit}`], { allowFailure: true });
  if (!object.ok) return false;
  const ancestor = await gitResult(repoRoot, ["merge-base", "--is-ancestor", checkpoint, tip], { allowFailure: true });
  return ancestor.ok;
}

async function emptyTree(repoRoot) {
  const result = await gitResult(repoRoot, ["mktree"], { input: "" });
  const oid = result.stdout.trim();
  if (!OID_RE.test(oid)) throw new Error("Git did not return an empty-tree object ID");
  return oid;
}

function nulPaths(stdout) {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

export async function mapDiffContext(repoRoot, mappedCommit, toCommit, hasMap, hasBaseline = hasMap) {
  let mode;
  let fromCommit = null;
  if (!hasMap) {
    mode = "initial";
  } else if (hasBaseline && mappedCommit !== null && await checkpointIsAncestor(repoRoot, mappedCommit, toCommit)) {
    mode = "incremental";
    fromCommit = mappedCommit;
  } else {
    mode = "full";
  }

  const fromTree = fromCommit ?? await emptyTree(repoRoot);
  const [names, patch] = await Promise.all([
    gitResult(repoRoot, ["diff", "--name-only", "-z", "--find-renames", fromTree, toCommit, "--"]),
    // Keep --binary absent: semantic mapping needs text hunks and change markers,
    // while encoded binary patch bodies can exceed the child-process output bound.
    gitResult(repoRoot, [
      "diff", "--no-ext-diff", "--no-textconv", "--full-index",
      "--find-renames", fromTree, toCommit, "--",
    ]),
  ]);
  return {
    mode,
    fromCommit,
    changedPaths: nulPaths(names.stdout),
    diff: patch.stdout,
  };
}

async function hashFileBlob(file, size, algorithm) {
  const hash = createHash(algorithm);
  hash.update(`blob ${size}\0`);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function hashBufferBlob(value, algorithm) {
  const hash = createHash(algorithm);
  hash.update(`blob ${value.byteLength}\0`);
  hash.update(value);
  return hash.digest("hex");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function verifyCommittedTree(snapshotPath, commit) {
  const format = (await gitResult(snapshotPath, ["rev-parse", "--show-object-format"])).stdout.trim();
  if (format !== "sha1" && format !== "sha256") throw new Error(`unsupported Git object format ${format}`);
  const tree = await gitResult(snapshotPath, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  const canonicalRoot = await realpath(snapshotPath);
  for (const record of tree.stdout.split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("Git returned an invalid tree entry");
    const [mode, type, oid] = record.slice(0, separator).split(" ");
    const relative = record.slice(separator + 1);
    if (relative.length === 0 || path.isAbsolute(relative) || relative.split("/").includes("..")) {
      throw new Error(`Git tree contains an unsafe path ${JSON.stringify(relative)}`);
    }
    const file = path.join(snapshotPath, ...relative.split("/"));
    if (type === "commit" && mode === "160000") continue;
    const info = await lstat(file).catch(() => null);
    if (mode === "120000" && type === "blob") {
      if (info === null || !info.isSymbolicLink()) throw new Error(`snapshot symlink ${relative} does not match commit`);
      const target = await readlink(file);
      const targetBytes = Buffer.from(target);
      if (hashBufferBlob(targetBytes, format) !== oid) throw new Error(`snapshot symlink ${relative} does not match commit`);
      const lexicalTarget = path.resolve(path.dirname(file), target);
      if (!inside(snapshotPath, lexicalTarget)) throw new Error(`snapshot symlink ${relative} points outside the snapshot`);
      const canonicalTarget = await realpath(file).catch(() => null);
      if (canonicalTarget !== null && !inside(canonicalRoot, canonicalTarget)) {
        throw new Error(`snapshot symlink ${relative} resolves outside the snapshot`);
      }
      continue;
    }
    if (type !== "blob" || mode !== "100644" && mode !== "100755") {
      throw new Error(`unsupported Git tree entry ${mode} ${type} at ${relative}`);
    }
    if (info === null || !info.isFile() || info.isSymbolicLink()) {
      throw new Error(`snapshot file ${relative} does not match commit`);
    }
    if ((mode === "100755") !== ((info.mode & 0o111) !== 0)) {
      throw new Error(`snapshot executable mode for ${relative} does not match commit`);
    }
    if (await hashFileBlob(file, info.size, format) !== oid) {
      throw new Error(`snapshot file ${relative} was changed by checkout filters or local configuration`);
    }
  }
}

async function makeReadOnly(target) {
  const entry = await lstat(target);
  if (entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    const children = await readdir(target);
    for (const child of children) await makeReadOnly(path.join(target, child));
    await chmod(target, entry.mode & 0o111 ? 0o555 : 0o444);
    return;
  }
  await chmod(target, entry.mode & 0o111 ? 0o555 : 0o444);
}

async function makeRemovable(target) {
  const entry = await lstat(target).catch(() => null);
  if (entry === null || entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    await chmod(target, entry.mode | 0o700);
    const children = await readdir(target);
    for (const child of children) await makeRemovable(path.join(target, child));
    return;
  }
  await chmod(target, entry.mode | 0o600);
}

async function worktreeRegistered(repoRoot, snapshotPath) {
  const listed = await gitResult(repoRoot, ["worktree", "list", "--porcelain", "-z"], { allowFailure: true });
  if (!listed.ok) return null;
  const wanted = await realpath(snapshotPath).catch(() => path.resolve(snapshotPath));
  for (const field of listed.stdout.split("\0")) {
    if (!field.startsWith("worktree ")) continue;
    const candidate = field.slice("worktree ".length);
    const canonical = await realpath(candidate).catch(() => path.resolve(candidate));
    if (canonical === wanted) return true;
  }
  return false;
}

export async function createPinnedSnapshot({ repoRoot, snapshotPath, commit, preparationId }) {
  const parent = path.dirname(snapshotPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  if (await lstat(snapshotPath).catch(() => null) !== null) {
    throw new Error(`refusing to replace existing mapping snapshot path ${snapshotPath}`);
  }
  let registered = false;
  try {
    await gitResult(repoRoot, [
      "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", snapshotPath, commit,
    ]);
    registered = true;
    const clean = await gitResult(snapshotPath, [
      "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching",
    ]);
    if (clean.stdout.length > 0) throw new Error("new mapping snapshot is not clean");
    await verifyCommittedTree(snapshotPath, commit);
    await gitResult(repoRoot, ["worktree", "lock", "--reason", `shape-map:${preparationId}`, snapshotPath]);
    await makeReadOnly(snapshotPath);
  } catch (error) {
    if (!registered) registered = await worktreeRegistered(repoRoot, snapshotPath) === true;
    if (!registered) throw error;
    try {
      await cleanupPinnedSnapshot({ repoRoot, snapshotPath });
    } catch (cleanupError) {
      const retained = new AggregateError(
        [error, cleanupError],
        `mapping snapshot creation failed and cleanup could not remove ${snapshotPath}`,
      );
      retained.snapshotRetained = true;
      throw retained;
    }
    throw error;
  }
}

export async function verifyPinnedSnapshot({ snapshotPath, commit }) {
  const head = (await gitResult(snapshotPath, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  if (head !== commit) throw new Error(`mapping snapshot moved from ${commit} to ${head || "an unknown commit"}`);
  const clean = await gitResult(snapshotPath, [
    "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching",
  ]);
  if (clean.stdout.length > 0) throw new Error("mapping snapshot was modified after preparation");
  await verifyCommittedTree(snapshotPath, commit);
}

export async function cleanupPinnedSnapshot({ repoRoot, snapshotPath }) {
  const registered = await worktreeRegistered(repoRoot, snapshotPath);
  const existing = await lstat(snapshotPath).catch(() => null);
  if (registered === false && existing === null) return;
  if (registered !== true) {
    throw new Error(`refusing to remove unverified mapping snapshot path ${snapshotPath}`);
  }
  await makeRemovable(snapshotPath);
  await gitResult(repoRoot, ["worktree", "unlock", snapshotPath], { allowFailure: true });
  const removed = await gitResult(repoRoot, ["worktree", "remove", "--force", snapshotPath], { allowFailure: true });
  if (!removed.ok) {
    await rm(snapshotPath, { recursive: true, force: true });
    const retry = await gitResult(repoRoot, ["worktree", "remove", "--force", snapshotPath], { allowFailure: true });
    if (!retry.ok) {
      const registered = await worktreeRegistered(repoRoot, snapshotPath);
      if (registered === false) return;
      const detail = retry.stderr.trim() || removed.stderr.trim() || "unknown error";
      throw new Error(`could not remove owned mapping worktree: ${detail}`);
    }
  }
}
