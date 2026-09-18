import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { mapDiffContext } from "./map-git.mjs";

const execFileAsync = promisify(execFile);
const OLD_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const BINARY_BYTES = OLD_MAX_BUFFER_BYTES + 1;
const DIFF_BOUND_BYTES = 64 * 1024;

async function git(repo, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd: repo });
  return stdout;
}

async function writeLargeBinary(file) {
  const handle = await open(file, "w");
  const chunk = randomBytes(1024 * 1024);
  chunk[0] = 0;
  try {
    for (let offset = 0; offset < BINARY_BYTES; offset += chunk.byteLength) {
      const length = Math.min(chunk.byteLength, BINARY_BYTES - offset);
      await handle.write(chunk, 0, length, offset);
    }
  } finally {
    await handle.close();
  }
}

test("mapDiffContext bounds committed binary changes without losing text hunks", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "shape-map-git-"));
  t.after(() => rm(repo, { recursive: true, force: true }));

  await git(repo, "init", "--quiet", "-b", "smoke");
  await mkdir(join(repo, "assets"));
  await writeLargeBinary(join(repo, "assets", "large.bin"));
  await writeFile(join(repo, "notes.txt"), "full text remains visible\n");
  await git(repo, "add", "--", "assets/large.bin", "notes.txt");
  await git(
    repo,
    "-c", "user.name=Shape Test",
    "-c", "user.email=shape-test@example.invalid",
    "-c", "core.hooksPath=/dev/null",
    "commit", "--quiet", "-m", "large binary fixture",
  );
  const commit = (await git(repo, "rev-parse", "HEAD")).trim();

  const context = await mapDiffContext(repo, null, commit, false);

  assert.ok(context.changedPaths.includes("assets/large.bin"));
  assert.match(context.diff, /^Binary files \/dev\/null and b\/assets\/large\.bin differ$/m);
  assert.match(context.diff, /^\+full text remains visible$/m);
  assert.doesNotMatch(context.diff, /^GIT binary patch$/m);
  assert.doesNotMatch(context.diff, /^(?:literal|delta) \d+$/m);
  assert.equal(context.diff.includes("\0"), false);
  assert.ok(
    Buffer.byteLength(context.diff) < DIFF_BOUND_BYTES,
    `diff was ${Buffer.byteLength(context.diff)} bytes; expected less than ${DIFF_BOUND_BYTES}`,
  );
});
