#!/usr/bin/env node
/**
 * Discovery/adopt smoke test. Runs the real bridge against scripts/fake-omp.mjs
 * in a throwaway target dir and drives the adopt wire over WebSocket:
 *
 *   hello.sessions        — the machine's running agent sessions, ours excluded
 *   discover -> sessions  — an on-demand re-scan
 *   adopt <bogus pid>     — rejected by name, bridge stays on its target
 *   adopt <real pid>      — retargets at that session's cwd, resuming its id
 *
 * The last check adopts a real interactive omp session running on this machine
 * (never one Shape spawned, never the bridge's own target). The harness the
 * adopted bridge starts is still the fake — `--omp` overrides the omp command
 * for every backend this bridge creates — so nothing is done to the real
 * session; what is asserted is that the bridge retargeted and passed
 * `--resume <that session's id>` down to the harness.
 *
 * Usage (from packages/bridge): node scripts/smoke-adopt.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = Number(process.env.SMOKE_PORT ?? 4404);
const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
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
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "init");
}

const target = await mkdtemp(join(tmpdir(), "vh-adopt-target-"));
const fakeHome = await mkdtemp(join(tmpdir(), "vh-adopt-home-"));
const fakeLog = join(fakeHome, "fake-omp.log");
await seedTarget(target);

const frames = [];
let bridge = null;
let socket = null;
/** cwd of the session we adopt, and whether it already had a `.shape/` */
let adopted = null;
let adoptedHadShape = true;

const send = (msg) => socket.send(JSON.stringify(msg));
const nextFrame = (predicate, label, timeoutMs) => {
  const from = frames.length;
  return waitFor(label, () => frames.slice(from).find(predicate), timeoutMs);
};

try {
  bridge = spawn(
    process.execPath,
    ["src/index.ts", "--cwd", target, "--port", String(PORT), "--omp", "node scripts/fake-omp.mjs"],
    {
      cwd: process.cwd(),
      // FAKE_OMP_LOG keeps the harness log out of whatever project we adopt, and
      // SHAPE_HOME keeps recents.json out of the real home dir. HOME is NOT
      // redirected: discovery reads the harnesses' real session stores under it,
      // and a fake home would hide every session id this test is about.
      env: { ...process.env, FAKE_OMP_LOG: fakeLog, SHAPE_HOME: fakeHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
    "hello excludes the harness children Shape spawned",
    sessions.every((s) => s.spawnedByShape === false),
    JSON.stringify(sessions.filter((s) => s.spawnedByShape).map((s) => s.pid)),
  );
  check(
    "hello does not offer this bridge's own fake harness",
    !sessions.some((s) => s.cwd === target),
    JSON.stringify(sessions.filter((s) => s.cwd === target).map((s) => s.pid)),
  );
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

  // --- adopt: a harness Shape has no adapter for -----------------------------

  // `exec -a cursor-agent sleep` is a real process that discovery classifies as
  // Cursor: enough to exercise the rejection without a Cursor install.
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
    send({ type: "adopt", pid: impostor.pid });
    const noAdapter = await nextFrame((f) => f.type === "error", "no-adapter rejection", 20_000);
    check(
      "adopt of a harness with no adapter is rejected by harness name",
      noAdapter.message === "no Shape adapter for cursor yet",
      noAdapter.message,
    );
    send({ type: "discover" });
    const kept = await nextFrame((f) => f.type === "sessions", "sessions after no-adapter", 20_000);
    check("a rejected harness leaves the bridge on its own target", Array.isArray(kept.sessions));
  } finally {
    impostor.kill("SIGKILL");
  }

  // --- adopt: a real interactive omp session ---------------------------------

  // Prefer a resumable session in a project that already has a `.shape/`, so the
  // check leaves no trace at all; fall back to any resumable omp session.
  const candidates = rescan.sessions.filter(
    (s) => s.harness === "omp" && s.sessionId !== null && s.cwd !== null && s.cwd !== target,
  );
  const pick =
    candidates.find((s) => existsSync(join(s.cwd, ".shape"))) ?? candidates[0] ?? null;

  if (pick === null) {
    check(
      "a real omp session was available to adopt",
      false,
      "no interactive omp session with a session id is running — start one and re-run",
    );
  } else {
    adopted = pick.cwd;
    adoptedHadShape = existsSync(join(adopted, ".shape"));
    console.error(`[smoke] adopting omp pid ${pick.pid} (${pick.sessionId.slice(0, 8)}) in ${adopted}`);
    send({ type: "adopt", pid: pick.pid });
    const after = await nextFrame((f) => f.type === "hello" || f.type === "error", "adopt hello", 60_000);
    check(
      "adopt of a real session answers with a hello, not an error",
      after.type === "hello",
      after.type === "error" ? after.message : "",
    );
    if (after.type === "hello") {
      check("adopt retargeted the bridge at the session's project", after.session.cwd === adopted, after.session.cwd);
      check("the adopted project is driven by the omp backend", after.session.backend?.id === "omp", JSON.stringify(after.session.backend ?? null));
      check(
        "the adopted harness reports a session (state primed after resume)",
        after.session.sessionId !== null,
        String(after.session.sessionId),
      );
      // the fake logs every frame it received, tagged with the argv it was started with
      const log = existsSync(fakeLog) ? readFileSync(fakeLog, "utf8") : "";
      const starts = log
        .split("\n")
        .filter((line) => line.includes('"__start"'))
        .map((line) => JSON.parse(line));
      const resumed = starts.at(-1);
      check(
        "the resumed session id was passed to the harness as --resume",
        resumed !== undefined &&
          Array.isArray(resumed.argv) &&
          resumed.argv.includes("--resume") &&
          resumed.argv.includes(pick.sessionId),
        JSON.stringify(resumed?.argv ?? null),
      );
      check(
        "adopting spawned a second harness child (the first was disposed)",
        starts.length >= 2,
        `${starts.length} start(s)`,
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
  // A project we adopted only to prove the wire must not keep a canvas it never had.
  if (adopted !== null && !adoptedHadShape) {
    await rm(join(adopted, ".shape"), { recursive: true, force: true });
    console.error(`[smoke] removed the .shape/ this run created in ${adopted}`);
  }
  await rm(target, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
}

console.log("");
for (const line of results) console.log(line);
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
