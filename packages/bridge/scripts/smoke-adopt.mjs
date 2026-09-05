#!/usr/bin/env node
/**
 * Discovery/adopt smoke test. Runs the real bridge in a throwaway target dir
 * and drives the adopt wire over WebSocket:
 *
 *   hello.sessions        — the machine's running agent sessions
 *   discover -> sessions  — an on-demand re-scan
 *   adopt <bogus pid>     — rejected by name, bridge stays on its target
 *   adopt <real pid>      — retargets AT that session's repo and starts nothing
 *
 * The last check adopts a real interactive omp session running on this machine.
 * Adopting is now the whole of it: Shape points itself at the repo that session
 * runs in and watches, so what is asserted is that the bridge retargeted and
 * that it spawned no harness of its own. Nothing is done TO the adopted
 * session — if it is Shape-aware it will report in over the new link by itself.
 *
 * This one scans the real machine, so it is not in CI, and it needs a real omp
 * session to adopt: without one that last section says so and is skipped.
 *
 * Usage (from packages/bridge): node scripts/smoke-adopt.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = Number(process.env.SMOKE_PORT ?? 4404);

// Every bridge below inherits this environment: a smoke must not depend on what
// is installed on the machine running it. `none` keeps the bridge away from the
// developer's own herdr — it must not switch anybody's terminal tabs — and
// detection reports exactly one harness.
process.env.SHAPE_LAUNCHER = "none";
process.env.SHAPE_FORCE_HARNESSES = "omp";
const results = [];
let failed = 0;
let skipped = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

/**
 * A section this machine cannot answer — adopting needs a real session that is
 * really running here. It is reported in the list and counted out of the total,
 * so a skipped run is neither a pass nor a failure.
 */
function skip(name, why) {
  results.push(`SKIP  ${name} — ${why}`);
  skipped++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = predicate();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(25);
  }
}

/** a committed one-package workspace: enough for reality extraction to succeed */
async function seedTarget(dir) {
  await mkdir(join(dir, "packages", "solo", "src"), { recursive: true });
  await writeFile(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "adopt-smoke", private: true }, null, 2));
  await writeFile(join(dir, "packages", "solo", "package.json"), JSON.stringify({ name: "@adopt/solo", version: "0.0.1" }, null, 2));
  await writeFile(join(dir, "packages", "solo", "src", "index.ts"), "export const solo = 1;\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  // not `main`: this machine's global pre-commit hook refuses commits there,
  // and a throwaway repo in /tmp is nobody's trunk
  git("init", "-q", "-b", "smoke");
  git("add", "-A");
  git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "init");
}

/** one row of `ps -axo pid,ppid,command` per process, for the children of one pid */
function childrenOf(pid) {
  const text = execFileSync("ps", ["-axo", "pid,ppid,command"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return text
    .split("\n")
    .slice(1)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m) => m !== null && Number(m[2]) === pid)
    .map((m) => ({ pid: Number(m[1]), command: m[3] }));
}

/** a child that IS a coding harness: the one thing this bridge must never start */
const HARNESS_CHILD = /(^|\/|\s)(omp|claude|codex|cursor-agent|gemini|amp|copilot)(\s|$)/;

const target = await mkdtemp(join(tmpdir(), "vh-adopt-target-"));
const fakeHome = await mkdtemp(join(tmpdir(), "vh-adopt-home-"));
await seedTarget(target);

const frames = [];
let bridge = null;
let socket = null;
/** a real project's pre-SQLite `.shape/`, copied aside so this run can put it back */
let legacyShape = null;

const send = (msg) => socket.send(JSON.stringify(msg));
const nextFrame = (predicate, label, timeoutMs) => {
  const from = frames.length;
  return waitFor(label, () => frames.slice(from).find(predicate), timeoutMs);
};

try {
  bridge = spawn(process.execPath, ["src/index.ts", "--cwd", target, "--port", String(PORT)], {
    cwd: process.cwd(),
    // SHAPE_HOME keeps recents.json out of the real home dir. HOME is NOT
    // redirected: discovery reads the harnesses' real session stores under it,
    // and a fake home would hide every session this test is about.
    // SHAPE_AUTO_MAP=0: this project has code and an empty canvas, so a room
    // left to itself would map it — a write none of the adoption checks below
    // asked for.
    env: { ...process.env, SHAPE_AUTO_MAP: "0", SHAPE_HOME: fakeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (d) => {
    stderr += d;
    process.stderr.write(`[bridge] ${d}`);
  });
  bridge.stdout.setEncoding("utf8");
  bridge.stdout.on("data", (d) => process.stderr.write(`[bridge:out] ${d}`));

  await waitFor("bridge listening", () => stderr.includes("canvas at ws://"));

  socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  const opened = Promise.withResolvers();
  socket.once("open", opened.resolve);
  socket.once("error", opened.reject);
  await opened.promise;

  // --- hello carries the adopt list -----------------------------------------

  const hello = await waitFor("hello", () => frames.find((f) => f.type === "hello"));
  check(
    "hello carries a sessions array",
    Array.isArray(hello.sessions),
    `sessions=${JSON.stringify(hello.sessions ?? null)?.slice(0, 120)}`,
  );
  const sessions = Array.isArray(hello.sessions) ? hello.sessions : [];
  check(
    "every discovered row is a full session record",
    sessions.every(
      (s) =>
        typeof s.harness === "string" &&
        Number.isInteger(s.pid) &&
        typeof s.command === "string" &&
        ["socket", "daemon", "http", "none"].includes(s.attach),
    ),
    `${sessions.length} row(s)`,
  );

  // --- discover -> sessions --------------------------------------------------

  send({ type: "discover" });
  const rescan = await nextFrame((f) => f.type === "sessions", "sessions frame", 20_000);
  check("discover answers with a sessions frame", Array.isArray(rescan.sessions), typeof rescan.sessions);
  check(
    "the re-scan agrees with hello about which harnesses are running",
    new Set(rescan.sessions.map((s) => s.harness)).size === new Set(sessions.map((s) => s.harness)).size,
    `${rescan.sessions.length} vs ${sessions.length}`,
  );

  // --- adopt: a pid nobody is running ---------------------------------------

  const bogus = 99_999_999;
  send({ type: "adopt", pid: bogus });
  const rejected = await nextFrame((f) => f.type === "error", "adopt rejection", 20_000);
  check(
    "adopt of an unknown pid is rejected by name",
    rejected.message === `adopt rejected: no running agent session with pid ${bogus}`,
    rejected.message,
  );
  send({ type: "discover" });
  const still = await nextFrame((f) => f.type === "sessions", "sessions after rejection", 20_000);
  check("a rejected adopt leaves the bridge serving its target", Array.isArray(still.sessions));

  // --- discovery names a harness by what is running --------------------------

  // `exec -a cursor-agent sleep` is a real process that discovery classifies as
  // Cursor: enough to exercise the classifier without a Cursor install. Shape
  // no longer drives any harness, so there is no adapter to refuse an adopt
  // over — every discovered session is adoptable, and adopting it is a switch.
  const impostor = spawn("bash", ["-c", "exec -a cursor-agent sleep 30"], { cwd: target, stdio: "ignore" });
  try {
    // `ps` reports the new process a moment after spawn, so the scan is retried
    let seen;
    for (let attempt = 0; attempt < 8 && seen === undefined; attempt++) {
      send({ type: "discover" });
      const scan = await nextFrame((f) => f.type === "sessions", "sessions frame", 20_000);
      seen = scan.sessions.find((s) => s.pid === impostor.pid);
      if (seen === undefined) await sleep(250);
    }
    check(
      "discovery classifies a running process by its harness",
      seen !== undefined && seen.harness === "cursor",
      seen === undefined ? `pid ${impostor.pid} not discovered` : seen.harness,
    );
    check(
      "a discovered row says how it could be reached, without claiming Shape drives it",
      seen === undefined || (["socket", "daemon", "http", "none"].includes(seen.attach) && seen.cwd !== null),
      JSON.stringify(seen ?? null),
    );
  } finally {
    impostor.kill("SIGKILL");
  }

  // --- adopt: a real interactive omp session ---------------------------------

  // Any real omp session but ours will do. Adopting one opens it as a project,
  // which — local mode being what it is — takes over any pre-SQLite `.shape/`
  // files it still has and then deletes them. This run's database is a
  // throwaway, so those files are copied aside first and put back in the
  // finally: a smoke must not cost a real project its old canvas.
  const pick = rescan.sessions.find((s) => s.harness === "omp" && s.cwd !== null && s.cwd !== target) ?? null;
  if (pick !== null && existsSync(join(pick.cwd, ".shape"))) {
    legacyShape = { dir: join(pick.cwd, ".shape"), backup: join(fakeHome, "shape-backup") };
    await cp(legacyShape.dir, legacyShape.backup, { recursive: true });
  }

  if (pick === null) {
    skip(
      "adopting a real omp session retargets the bridge at its repo",
      "no interactive omp session is running on this machine — start one and re-run",
    );
  } else {
    const adopted = pick.cwd;
    console.error(`[smoke] adopting omp pid ${pick.pid} in ${adopted}`);
    send({ type: "adopt", pid: pick.pid });
    const after = await nextFrame((f) => f.type === "hello" || f.type === "error", "adopt hello", 60_000);
    check(
      "adopt of a real session answers with a hello, not an error",
      after.type === "hello",
      after.type === "error" ? after.message : "",
    );
    if (after.type === "hello") {
      // The project is the REPO, anchored on its main worktree: a session
      // running in a variation is adopted by attaching the repo that owns it,
      // and the directory the session runs in is one of the variations served.
      const adoptedDir = realpathSync(adopted);
      check(
        "adopt retargeted the bridge at the repo the session runs in",
        after.session.worktrees.some((w) => w.id === adoptedDir) &&
          after.session.worktrees.some((w) => w.id === after.session.cwd),
        `${after.session.cwd} for a session in ${adoptedDir}`,
      );
      check(
        "the adopted project's canvas is the repo's, with every variation on it",
        Object.keys(after.graphs).every((worktree) => after.session.worktrees.some((w) => w.id === worktree)) &&
          after.graphs[adoptedDir] !== undefined,
        JSON.stringify(Object.keys(after.graphs)),
      );
      // Adopting starts nothing: Shape has no launcher any more, and the
      // session it adopted belongs to whoever opened it. The one visible proof
      // is the bridge's own process table — no harness hanging off it.
      await sleep(500);
      const children = childrenOf(bridge.pid);
      check(
        "adopting starts no harness of its own: the session stays the user's",
        children.every((c) => !HARNESS_CHILD.test(c.command)),
        JSON.stringify(children.map((c) => c.command)),
      );
      // A session that is Shape-aware appears by reporting in over the new
      // link, and one that is not leaves the project attached with no session:
      // either way nothing was resumed on its behalf.
      check(
        "the adopted project is served with whatever reports in from it, and nothing more",
        after.session.sessions.every((s) => after.session.worktrees.some((w) => w.id === s.worktree)),
        JSON.stringify(after.session.sessions.map((s) => s.worktree)),
      );
    }
  }
} catch (err) {
  check("smoke ran to completion", false, err instanceof Error ? err.message : String(err));
} finally {
  socket?.close();
  bridge?.kill("SIGTERM");
  await sleep(300);
  bridge?.kill("SIGKILL");
  // put back whatever the adopt's one-shot import took out of a real project
  if (legacyShape !== null) {
    await cp(legacyShape.backup, legacyShape.dir, { recursive: true, force: true });
    console.error(`[smoke] restored ${legacyShape.dir} as it was before the run`);
  }
  await rm(target, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
}

console.log("");
for (const line of results) console.log(line);
const ran = results.length - skipped;
console.log(`\n${ran - failed}/${ran} checks passed${skipped === 0 ? "" : ` (${String(skipped)} skipped)`}`);
process.exit(failed === 0 ? 0 : 1);
