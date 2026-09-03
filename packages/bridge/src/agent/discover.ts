/**
 * Discovery of coding-agent sessions already running on this machine.
 *
 * Read-only probe, zero dependencies: one `ps` sweep classifies processes by
 * executable + argv, one batched `lsof` (or `/proc` on Linux) resolves working
 * directories, and each harness's own on-disk session store maps a directory
 * back to the session id you would resume with.
 *
 * Every external command is time-boxed (3 s) and every failure — missing
 * binary, unreadable store, malformed record — degrades to `null` fields.
 * `discoverSessions()` never rejects.
 *
 * Not wired into the bridge; see `discover-cli.ts` for the standalone probe
 * (`node packages/bridge/src/agent/discover-cli.ts`).
 */

import { execFile } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join } from "node:path";

import type { DiscoveredSession, Harness } from "../../../shared/src/index.ts";

export type { DiscoveredSession, Harness } from "../../../shared/src/index.ts";

const EXEC_TIMEOUT_MS = 3_000;
/** Bytes read from the head of a session log to sniff its metadata line. */
const HEAD_BYTES = 128 * 1024;
/** `ps` reports start times to the second; don't let rounding disown a session file. */
const START_SLACK_MS = 2_000;

const HOME = homedir();
const IS_DARWIN = platform() === "darwin";

/* ------------------------------------------------------------------ process */

interface ProcRow {
  pid: number;
  ppid: number;
  startedAt: string | null;
  command: string;
  argv: string[];
}

/** `Wed Sep  2 16:17:54 2026` — the fixed 5-token `lstart` form. */
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;

/** Run a command, resolving to null on any failure (missing binary, timeout, non-zero). */
function run(file: string, args: string[]): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  execFile(
    file,
    args,
    { timeout: EXEC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
    (err, stdout) => resolve(err !== null ? null : stdout),
  );
  return promise;
}

function parsePs(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = PS_ROW.exec(line);
    if (m === null) continue;
    const command = m[4]!.trim();
    const startedMs = Date.parse(m[3]!.replace(/\s+/g, " "));
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      startedAt: Number.isNaN(startedMs) ? null : new Date(startedMs).toISOString(),
      command,
      argv: command.split(/\s+/),
    });
  }
  return rows;
}

/* --------------------------------------------------------------- classifier */

/** Subcommands of a harness binary that are tooling or a server, not a conversation. */
const NON_SESSION_SUBCOMMANDS: Record<string, true> = {
  "app-server": true,
  attach: true,
  completion: true,
  config: true,
  doctor: true,
  e: true,
  exec: true,
  install: true,
  login: true,
  logout: true,
  ls: true,
  mcp: true,
  "migrate-installer": true,
  serve: true,
  "setup-token": true,
  update: true,
  web: true,
};

/**
 * Harness for a process, or null. Rules (in order):
 * - `omp` in flag form (`omp`, `omp --resume <id>`, `omp --mode rpc`); the internal
 *   `omp browser-relay` / `omp __omp_worker_daemon_broker` helpers are subcommands, so out.
 * - `claude`, or a node process running `.../claude-code/cli.js`, `.../claude/versions/...`
 *   or `cli-wrapper.cjs`.
 * - `codex` except `app-server` / `exec` and the tooling subcommands.
 * - `opencode` in flag form (the TUI), or a bun/node process whose argv names `opencode`.
 * - `cursor-agent`, or `agent` living under `~/.cursor/bin`.
 */
function classify(argv: string[]): Harness | null {
  const exe = argv[0] ?? "";
  const base = basename(exe);
  const sub = argv[1] ?? "";
  const rest = argv.slice(1);
  // Flag form = bare binary or `binary --flags`, never `binary subcommand`.
  const flagForm = sub === "" || sub.startsWith("-");
  const nodeLike = base === "node" || base === "bun" || base === "deno" || /^node[\d.]*$/.test(base);

  if (base === "omp" && flagForm) return "omp";

  if (base === "claude" && NON_SESSION_SUBCOMMANDS[sub] !== true) return "claude";
  if (nodeLike && rest.some((a) => /claude-code\/cli\.js$|\/claude\/versions\/|cli-wrapper\.cjs$/.test(a))) {
    return "claude";
  }

  if (base === "codex" && NON_SESSION_SUBCOMMANDS[sub] !== true) return "codex";

  if (base === "opencode" && flagForm) return "opencode";
  if (nodeLike && rest.some((a) => basename(a) === "opencode")) return "opencode";

  if (base === "cursor-agent") return "cursor";
  if (base === "agent" && exe.includes("/.cursor/bin/")) return "cursor";
  if (nodeLike && rest.some((a) => /\/\.cursor\/bin\/(cursor-)?agent$/.test(a))) return "cursor";

  return null;
}

/** A Shape bridge: node running the bridge entrypoint out of `packages/bridge`. */
function looksLikeShapeBridge(row: ProcRow | undefined, cwd: string | null): boolean {
  if (row === undefined) return false;
  if (row.command.includes("packages/bridge") || row.command.includes("@shape/bridge")) return true;
  return (cwd ?? "").endsWith("/packages/bridge") && row.command.includes("index.ts");
}

/* ----------------------------------------------------------------- cwd probe */

/** cwd per pid. macOS: one batched `lsof`. Linux: `/proc/<pid>/cwd`. */
async function resolveCwds(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;

  if (IS_DARWIN === false) {
    for (const pid of pids) {
      try {
        out.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        /* gone, or not ours to read */
      }
    }
    return out;
  }

  // `-Fn` emits `p<pid>` / `f<fd>` / `n<path>` lines; a `p` line opens each process.
  const stdout = await run("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"]);
  if (stdout === null) return out;
  let current: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      current = Number.isNaN(pid) ? null : pid;
    } else if (line.startsWith("n") && current !== null) {
      out.set(current, line.slice(1));
      current = null;
    }
  }
  return out;
}

/* --------------------------------------------------------------- disk helpers */

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Newest entry in `dir` matching `keep`, by mtime, ignoring anything last
 * written before `notBefore` (ms). Recency alone is not enough to tie a session
 * file to a process: a project directory keeps every session it ever held, so a
 * freshly started agent would otherwise inherit a stranger's transcript.
 */
function newestEntry(dir: string, keep: (name: string) => boolean, notBefore = 0): string | null {
  let best: string | null = null;
  let bestAt = -1;
  for (const name of listDir(dir)) {
    if (keep(name) === false) continue;
    const path = join(dir, name);
    const at = mtimeOf(path);
    if (at < notBefore || at <= bestAt) continue;
    bestAt = at;
    best = path;
  }
  return best;
}

/**
 * Every harness encodes a project path into a directory name by squashing
 * separators to dashes, and some drop the home prefix. Comparing this
 * separator-insensitive key matches all of those spellings without replicating
 * each harness's exact escaping.
 */
function pathKey(path: string): string {
  return path
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** Sub-directory of `root` whose name encodes `cwd` (absolute or home-relative). */
function projectDirFor(root: string, cwd: string | null): string | null {
  if (cwd === null) return null;
  const wanted = [pathKey(cwd)];
  if (cwd.startsWith(`${HOME}/`)) wanted.push(pathKey(cwd.slice(HOME.length)));
  for (const name of listDir(root)) {
    if (wanted.includes(pathKey(name))) return join(root, name);
  }
  return null;
}

/** First `HEAD_BYTES` of a file as text (session logs put their metadata up front). */
function readHead(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const read = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString("utf8", 0, read);
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Value of a JSON string field in a head chunk. Regex rather than `JSON.parse`
 * on purpose: a Codex rollout's first line can carry megabytes of base
 * instructions, so the line is often not complete inside the chunk we read.
 */
function jsonField(head: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(head);
  if (m === null) return null;
  try {
    return JSON.parse(`"${m[1]!}"`) as string;
  } catch {
    return m[1]!;
  }
}

/* ------------------------------------------------------------ session stores */

interface SessionRef {
  sessionId: string | null;
  sessionFile: string | null;
}

const NONE: SessionRef = { sessionId: null, sessionFile: null };

/**
 * omp: `~/.omp/agent/sessions/<encoded cwd>/<iso>_<uuid>.jsonl`. An explicit
 * `--resume <id>` / `-r <id>` on the command line names the session outright (it
 * may be an id prefix, so match by prefix) and needs no `notBefore` guard.
 */
function ompSession(cwd: string | null, argv: string[], notBefore: number): SessionRef {
  const dir = projectDirFor(join(HOME, ".omp", "agent", "sessions"), cwd);
  if (dir === null) return NONE;

  const flag = argv.findIndex((a) => a === "--resume" || a === "-r");
  const resumeArg = flag === -1 ? null : (argv[flag + 1] ?? null);
  const wanted = resumeArg !== null && resumeArg.startsWith("-") === false ? resumeArg : null;

  const file =
    wanted === null
      ? newestEntry(dir, (name) => name.endsWith(".jsonl"), notBefore)
      : newestEntry(dir, (name) => name.endsWith(".jsonl") && name.includes(`_${wanted}`));
  if (file === null) return NONE;

  // `<iso timestamp>_<session id>.jsonl`
  const stem = basename(file, ".jsonl");
  const underscore = stem.lastIndexOf("_");
  return { sessionId: underscore === -1 ? stem : stem.slice(underscore + 1), sessionFile: file };
}

/**
 * Claude Code: `~/.claude/projects/<cwd with / and . as ->/<session id>.jsonl`,
 * newest by mtime; the record's own `sessionId` wins over the filename.
 */
function claudeSession(cwd: string | null, notBefore: number): SessionRef {
  const dir = projectDirFor(join(HOME, ".claude", "projects"), cwd);
  if (dir === null) return NONE;
  const file = newestEntry(dir, (name) => name.endsWith(".jsonl"), notBefore);
  if (file === null) return NONE;
  return { sessionId: jsonField(readHead(file), "sessionId") ?? basename(file, ".jsonl"), sessionFile: file };
}

/**
 * Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` whose leading
 * `session_meta` records a matching `cwd`. Walked newest-day-first and capped,
 * because the store accumulates thousands of rollouts.
 */
function codexSession(cwd: string | null, notBefore: number): SessionRef {
  if (cwd === null) return NONE;
  const root = join(HOME, ".codex", "sessions");
  const wanted = pathKey(cwd);
  const newestFirst = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);
  let budget = 400;

  for (const year of listDir(root).sort(newestFirst)) {
    for (const month of listDir(join(root, year)).sort(newestFirst)) {
      for (const day of listDir(join(root, year, month)).sort(newestFirst)) {
        const dir = join(root, year, month, day);
        for (const name of listDir(dir).sort(newestFirst)) {
          if (name.startsWith("rollout-") === false || name.endsWith(".jsonl") === false) continue;
          if (budget-- <= 0) return NONE;
          if (mtimeOf(join(dir, name)) < notBefore) continue;
          const head = readHead(join(dir, name));
          const metaCwd = jsonField(head, "cwd");
          if (metaCwd === null || pathKey(metaCwd) !== wanted) continue;
          const fromName = name.replace(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+?-/, "").replace(/\.jsonl$/, "");
          return { sessionId: jsonField(head, "session_id") ?? fromName, sessionFile: join(dir, name) };
        }
      }
    }
  }
  return NONE;
}

/**
 * opencode: `<data>/storage/session/<projectID>/<sessionID>.json`, newest record
 * whose `directory` is the process cwd. Documented layout — this machine has no
 * opencode install, so it is unverified here.
 */
function opencodeSession(cwd: string | null, notBefore: number): SessionRef {
  if (cwd === null) return NONE;
  const wanted = pathKey(cwd);
  let best: SessionRef = NONE;
  let bestAt = -1;
  const dataDirs = [join(HOME, "Library", "Application Support", "opencode"), join(HOME, ".local", "share", "opencode")];

  for (const data of dataDirs) {
    const root = join(data, "storage", "session");
    for (const project of listDir(root)) {
      const dir = join(root, project);
      for (const name of listDir(dir)) {
        if (name.endsWith(".json") === false) continue;
        const file = join(dir, name);
        const at = mtimeOf(file);
        if (at < notBefore || at <= bestAt) continue;
        let record: { directory?: unknown; id?: unknown };
        try {
          record = JSON.parse(readFileSync(file, "utf8")) as { directory?: unknown; id?: unknown };
        } catch {
          continue;
        }
        if (typeof record.directory !== "string" || pathKey(record.directory) !== wanted) continue;
        bestAt = at;
        best = { sessionId: typeof record.id === "string" ? record.id : basename(file, ".json"), sessionFile: file };
      }
    }
  }
  return best;
}

/**
 * Cursor: `~/.cursor/projects/<encoded cwd>/agent-transcripts/<session id>/`,
 * newest transcript directory. Documented layout — no cursor install here.
 */
function cursorSession(cwd: string | null, notBefore: number): SessionRef {
  const project = projectDirFor(join(HOME, ".cursor", "projects"), cwd);
  if (project === null) return NONE;
  const dir = newestEntry(join(project, "agent-transcripts"), () => true, notBefore);
  if (dir === null) return NONE;
  const id = basename(dir).replace(/\.jsonl$/, "");
  const transcript = join(dir, `${id}.jsonl`);
  return { sessionId: id, sessionFile: exists(transcript) ? transcript : dir };
}

/* -------------------------------------------------------------------- attach */

/**
 * Can another process talk to this session?
 * - claude → its local IPC socket `/tmp/cc-socks/<pid>.sock`
 * - codex  → the app-server daemon, when its pid file names a live process
 * - opencode → HTTP, but only when the TUI was started with `--port`
 * - omp / cursor → nothing to attach to
 */
function attachFor(harness: Harness, pid: number, argv: string[]): DiscoveredSession["attach"] {
  if (harness === "claude") return exists(`/tmp/cc-socks/${pid}.sock`) ? "socket" : "none";
  if (harness === "opencode") return argv.some((a) => a === "--port" || a.startsWith("--port=")) ? "http" : "none";
  if (harness === "codex") {
    let daemon = Number.NaN;
    try {
      daemon = Number.parseInt(readFileSync(join(HOME, ".codex", "app-server-daemon", "app-server.pid"), "utf8").trim(), 10);
    } catch {
      return "none";
    }
    if (Number.isNaN(daemon)) return "none";
    try {
      process.kill(daemon, 0);
      return "daemon";
    } catch {
      return "none";
    }
  }
  return "none";
}

function resumeCommandFor(harness: Harness, sessionId: string | null): string[] | null {
  if (sessionId === null) return null;
  switch (harness) {
    case "omp":
      return ["omp", "--resume", sessionId];
    case "claude":
      return ["claude", "--resume", sessionId];
    case "codex":
      return ["codex", "resume", sessionId];
    case "opencode":
      return ["opencode", "--session", sessionId];
    case "cursor":
      return ["agent", "resume", sessionId];
  }
}

function sessionRefFor(harness: Harness, cwd: string | null, argv: string[], notBefore: number): SessionRef {
  switch (harness) {
    case "omp":
      return ompSession(cwd, argv, notBefore);
    case "claude":
      return claudeSession(cwd, notBefore);
    case "codex":
      return codexSession(cwd, notBefore);
    case "opencode":
      return opencodeSession(cwd, notBefore);
    case "cursor":
      return cursorSession(cwd, notBefore);
  }
}

/* ---------------------------------------------------------------- discovery */

/**
 * Coding-agent sessions running on this machine, newest first.
 *
 * Best-effort by construction: an unreadable session store or a missing `lsof`
 * costs you `cwd`/`sessionId`, not the row.
 */
export async function discoverSessions(): Promise<DiscoveredSession[]> {
  const stdout = await run("ps", ["-axo", "pid=,ppid=,lstart=,command="]);
  if (stdout === null) return [];

  const rows = parsePs(stdout);
  const byPid = new Map<number, ProcRow>(rows.map((row) => [row.pid, row]));

  const hits: { row: ProcRow; harness: Harness }[] = [];
  for (const row of rows) {
    const harness = classify(row.argv);
    if (harness !== null) hits.push({ row, harness });
  }
  if (hits.length === 0) return [];

  // Parents too: an `omp --mode rpc` row is only Shape's if its parent is a bridge.
  const probe = new Set<number>();
  for (const { row } of hits) {
    probe.add(row.pid);
    if (byPid.has(row.ppid)) probe.add(row.ppid);
  }
  const cwds = await resolveCwds([...probe]);

  const sessions = hits.map(({ row, harness }) => {
    const cwd = cwds.get(row.pid) ?? null;
    // A session file older than the process cannot be that process's own.
    const notBefore = row.startedAt === null ? 0 : Date.parse(row.startedAt) - START_SLACK_MS;
    const { sessionId, sessionFile } = sessionRefFor(harness, cwd, row.argv, notBefore);
    const rpcChild = harness === "omp" && row.argv.includes("--mode") && row.argv.includes("rpc");
    return {
      harness,
      pid: row.pid,
      command: row.command,
      cwd,
      sessionId,
      sessionFile,
      startedAt: row.startedAt,
      resumeCommand: resumeCommandFor(harness, sessionId),
      attach: rpcChild ? "none" : attachFor(harness, row.pid, row.argv),
      spawnedByShape: rpcChild && looksLikeShapeBridge(byPid.get(row.ppid), cwds.get(row.ppid) ?? null),
    } satisfies DiscoveredSession;
  });

  return sessions.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || b.pid - a.pid);
}
