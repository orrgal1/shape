#!/usr/bin/env node
/**
 * Wire smoke for worktrees on one canvas: the boundary validators and the
 * SQLite store are what every other part of Shape trusts, so they are checked
 * here on their own — and so are the two fakes the harness-level smokes stand
 * on, because a fake that lies is worse than no fake.
 *
 * Five sections:
 *   1. every agent-link frame, both directions, round-tripped through
 *      `parseAgentToServerMsg` / `parseServerToAgentMsg` — accepted whole, and
 *      rejected when the worktree it is about is missing or empty
 *   2. every browser frame through `parseClientMsg`, the same way, plus the
 *      frames a steering Shape used to send and this one cannot parse at all
 *   3. `openSqliteStorage`: worktree-keyed graphs, revisions and audit lines,
 *      the v1 → v2 migration that puts a pre-worktree canvas on the main
 *      worktree of its project, and `adoptLegacyKey` moving a canvas off the
 *      project key an older Shape derived from a worktree's directory
 *   4. every loopback frame through `parseLinkMsg`, including the `delivered`
 *      receipt a harness on an older integration still sends: it parses, and
 *      `ExternalIo` then drops it without an answer
 *   5. the fakes, for real: `scripts/fake-omp-tui.mjs` against a bare
 *      WebSocket server (hello, a turn typed into its stdin, `bye` on SIGTERM
 *      — every frame it sends read back through `parseLinkMsg`), and
 *      `scripts/fake-herdr.mjs` over its unix socket (tab, agent, prompt,
 *      list, focus, close, events) with the real server's framing: one
 *      exchange per connection and then a hang-up, and status subscribed per
 *      pane
 *
 * Usage (from packages/bridge): node scripts/smoke-wire.mjs
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import { ExternalIo } from "../src/agent/external.ts";
import { isHerdrClient, parsePsRows, terminalAppOf } from "../src/agent/launcher/herdr.ts";
import { parseLinkMsg } from "../src/agent/linkparse.ts";
import { parseAgentToServerMsg, parseServerToAgentMsg } from "../src/linkframes.ts";
import { openSqliteStorage } from "../src/server/sqlite.ts";
import { parseClientMsg } from "../src/server/ws.ts";

const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

/**
 * A frame survives its validator unchanged, and the same frame without its
 * `worktree` (and with an empty one) is refused: an unplaceable frame must not
 * reach a room that would have to guess which canvas it is about.
 */
function roundTrip(parse, label, frame, { worktreeScoped = true } = {}) {
  const parsed = parse(JSON.stringify(frame));
  check(`${label}: accepted`, parsed !== null, "validator returned null");
  if (parsed !== null) {
    check(`${label}: survives the round trip unchanged`, JSON.stringify(parsed) === JSON.stringify(frame), JSON.stringify(parsed));
  }
  if (!worktreeScoped) return;
  const { worktree: _dropped, ...without } = frame;
  check(`${label}: refused without a worktree`, parse(JSON.stringify(without)) === null);
  check(`${label}: refused with an empty worktree`, parse(JSON.stringify({ ...frame, worktree: "" })) === null);
}

const WT = "/repo/main";
const WT2 = "/repo/feature";

const CAPABILITIES = {
  steerMidTurn: false,
  hostTool: true,
  events: "native",
  resume: false,
  // the session runs in a terminal of its own, which Shape can only focus
  terminal: "external",
};
const BACKEND = { id: "omp", label: "agent", capabilities: CAPABILITIES };
const SESSION = { sessionId: "s-1", sessionName: "shape", model: { provider: "anthropic", id: "claude" } };
const LEGACY = { [WT]: "k-legacy-main", [WT2]: "k-legacy-feature" };
/** what the agent's machine has: the multiplexer a session can be focused in */
const TOOLS = {
  launcher: "herdr",
  launchers: [{ id: "herdr", label: "herdr", path: "/usr/local/bin/herdr", version: "0.8.0" }],
  harnesses: [
    { id: "omp", label: "omp", path: "/usr/local/bin/omp", version: "1.2.3" },
    { id: "claude", label: "Claude Code", path: "/usr/local/bin/claude", version: null },
  ],
};
/** one session somebody started themselves, as the agent's scan reports it */
const DISCOVERED = {
  harness: "omp",
  pid: 4242,
  command: "omp",
  cwd: WT2,
  sessionId: "s-9",
  sessionFile: "/tmp/fake/s-9.jsonl",
  startedAt: "2026-01-01T00:00:00.000Z",
  resumeCommand: null,
  attach: "socket",
};
const PROJECT = {
  key: "k-1",
  label: "repo",
  cwd: WT,
  backend: BACKEND,
  tools: TOOLS,
  targetHasCode: true,
  directivePath: "/home/u/.shape/server/projects/k-1/shape-directive.md",
  // no manager tab open in this project's workspace, which is the usual state
  manager: null,
  legacyKeys: LEGACY,
};
const REALITY = { nodes: [], edges: [], symbols: [], infra: [], verification: [], extractedAt: null, head: "abc123" };
const WORKTREES = [
  { id: WT, path: WT, branch: "main", head: "abc123" },
  { id: WT2, path: WT2, branch: "feature", head: "def456" },
];

// ---------------------------------------------------------------------------
// 1. Agent link: agent → server
// ---------------------------------------------------------------------------

{
  const attach = {
    type: "attach",
    project: PROJECT,
    worktrees: WORKTREES,
    sessions: [{ worktree: WT, session: SESSION, backend: BACKEND, state: "idle" }],
    realities: { [WT]: REALITY },
    discovered: [],
    recentProjects: [WT],
  };
  roundTrip(parseAgentToServerMsg, "attach", attach, { worktreeScoped: false });

  check(
    "attach: a worktree row without an id is refused",
    parseAgentToServerMsg(JSON.stringify({ ...attach, worktrees: [{ path: WT, branch: null, head: null }] })) === null,
  );
  check(
    "attach: a session naming no worktree is refused",
    parseAgentToServerMsg(
      JSON.stringify({ ...attach, sessions: [{ session: SESSION, backend: BACKEND, state: "idle" }] }),
    ) === null,
  );
  check(
    "attach: a session with an unknown state is refused",
    parseAgentToServerMsg(
      JSON.stringify({ ...attach, sessions: [{ worktree: WT, session: SESSION, backend: BACKEND, state: "thinking" }] }),
    ) === null,
  );
  check(
    "attach: a session with no backend is refused",
    parseAgentToServerMsg(JSON.stringify({ ...attach, sessions: [{ worktree: WT, session: SESSION, state: "idle" }] })) === null,
  );
  check(
    "attach: no running harness is a legitimate attach",
    parseAgentToServerMsg(JSON.stringify({ ...attach, sessions: [] }))?.sessions.length === 0,
  );
  const noRealities = parseAgentToServerMsg(JSON.stringify({ ...attach, realities: undefined }));
  check(
    "attach: an agent that extracted nothing attaches with no realities",
    noRealities !== null && Object.keys(noRealities.realities).length === 0,
    JSON.stringify(noRealities?.realities),
  );
  const badReality = parseAgentToServerMsg(JSON.stringify({ ...attach, realities: { [WT]: REALITY, [WT2]: 7 } }));
  check(
    "attach: one unreadable reality costs that worktree, not the attach",
    badReality !== null && Object.keys(badReality.realities).join() === WT,
    JSON.stringify(badReality?.realities && Object.keys(badReality.realities)),
  );

  const noLegacy = parseAgentToServerMsg(JSON.stringify({ ...attach, project: { ...PROJECT, legacyKeys: undefined } }));
  check(
    "attach: an agent that names no legacy keys leaves nothing to adopt",
    noLegacy !== null && Object.keys(noLegacy.project.legacyKeys).length === 0,
    JSON.stringify(noLegacy?.project.legacyKeys),
  );
  const badLegacy = parseAgentToServerMsg(
    JSON.stringify({ ...attach, project: { ...PROJECT, legacyKeys: { [WT]: "k-legacy-main", [WT2]: "", "": "k-x", bad: 7 } } }),
  );
  check(
    "attach: an unusable legacy key costs that worktree, not the attach",
    badLegacy !== null && Object.keys(badLegacy.project.legacyKeys).join() === WT,
    JSON.stringify(badLegacy?.project.legacyKeys),
  );

  const noLauncher = parseAgentToServerMsg(
    JSON.stringify({ ...attach, project: { ...PROJECT, tools: { ...TOOLS, launcher: null } } }),
  );
  check(
    "attach: an agent with no multiplexer names no launcher, and still attaches",
    noLauncher !== null && noLauncher.project.tools.launcher === null,
    JSON.stringify(noLauncher?.project.tools.launcher),
  );
  check(
    "attach: a session whose terminal is a kind Shape cannot show is refused",
    parseAgentToServerMsg(
      JSON.stringify({
        ...attach,
        sessions: [
          {
            worktree: WT,
            session: SESSION,
            backend: { ...BACKEND, capabilities: { ...CAPABILITIES, terminal: "drawer" } },
            state: "idle",
          },
        ],
      }),
    ) === null,
  );
}

roundTrip(parseAgentToServerMsg, "session_started", {
  type: "session_started",
  worktree: WT2,
  session: SESSION,
  backend: BACKEND,
});
roundTrip(parseAgentToServerMsg, "session_stopped", { type: "session_stopped", worktree: WT2, reason: "closed" });
roundTrip(parseAgentToServerMsg, "agent_event", {
  type: "agent_event",
  worktree: WT,
  event: { kind: "state", state: "streaming" },
});
roundTrip(parseAgentToServerMsg, "canvas_call", { type: "canvas_call", worktree: WT, id: "c-1", args: { ops: [] } });
roundTrip(parseAgentToServerMsg, "reality", { type: "reality", worktree: WT2, reality: REALITY, head: "def456" });
roundTrip(parseAgentToServerMsg, "skeleton_result", { type: "skeleton_result", worktree: WT, id: "s-1", ops: [] });
// project-wide answers stay project-wide: they are about the agent, not one harness
roundTrip(parseAgentToServerMsg, "worktrees", { type: "worktrees", id: "w-1", worktrees: WORKTREES }, { worktreeScoped: false });
// what the agent's scan found running on the machine, answered by request id
roundTrip(parseAgentToServerMsg, "sessions", { type: "sessions", id: "d-1", sessions: [DISCOVERED] }, { worktreeScoped: false });
roundTrip(parseAgentToServerMsg, "agent_error", { type: "agent_error", message: "no such worktree" }, { worktreeScoped: false });
// the chooser's answer is about the machine, not about one variation
roundTrip(parseAgentToServerMsg, "folder_picked", { type: "folder_picked", path: "/chosen/project" }, { worktreeScoped: false });
roundTrip(parseAgentToServerMsg, "folder_picked cancelled", { type: "folder_picked", path: null }, { worktreeScoped: false });
check(
  "folder_picked: an empty path is neither an answer nor a folder",
  parseAgentToServerMsg(JSON.stringify({ type: "folder_picked", path: "" })) === null,
);
check(
  "folder_picked: a path that is not a string is refused",
  parseAgentToServerMsg(JSON.stringify({ type: "folder_picked", path: 7 })) === null,
);

// ---------------------------------------------------------------------------
// 2. Agent link: server → agent
// ---------------------------------------------------------------------------

roundTrip(parseServerToAgentMsg, "attached", { type: "attached", projectId: "k-1" }, { worktreeScoped: false });
roundTrip(parseServerToAgentMsg, "focus_terminal", { type: "focus_terminal", worktree: WT });
roundTrip(parseServerToAgentMsg, "extract_reality", { type: "extract_reality", worktree: WT2 });
roundTrip(parseServerToAgentMsg, "synthesize_skeleton", { type: "synthesize_skeleton", worktree: WT, id: "s-1" });
roundTrip(
  parseServerToAgentMsg,
  "canvas_result",
  { type: "canvas_result", id: "c-1", text: "applied 3 op(s);", isError: false },
  { worktreeScoped: false },
);
// the chooser is a dialog on the agent's machine: no worktree, no fields
roundTrip(parseServerToAgentMsg, "pick_folder", { type: "pick_folder" }, { worktreeScoped: false });
roundTrip(parseServerToAgentMsg, "discover", { type: "discover", id: "d-1" }, { worktreeScoped: false });
// project-wide questions stay project-wide: they are about the agent's machine
roundTrip(parseServerToAgentMsg, "list_worktrees", { type: "list_worktrees", id: "w-1" }, { worktreeScoped: false });
// adopting a discovered session is retargeting onto its cwd: nothing is started
roundTrip(parseServerToAgentMsg, "adopt", { type: "adopt", pid: 4242 }, { worktreeScoped: false });

{
  // the whole agent is retargeted BY PATH, and the path is all a switch says
  roundTrip(parseServerToAgentMsg, "switch", { type: "switch", path: WT2 }, { worktreeScoped: false });
  const extras = parseServerToAgentMsg(
    JSON.stringify({ type: "switch", path: `  ${WT2}  `, backend: "claude", resumeSessionId: "r-1" }),
  );
  check(
    "switch: the path is trimmed, and what an older Shape would have started with it is dropped",
    JSON.stringify(extras) === JSON.stringify({ type: "switch", path: WT2 }),
    JSON.stringify(extras),
  );
  check("switch: a blank path is refused", parseServerToAgentMsg(JSON.stringify({ type: "switch", path: "  " })) === null);
  check(
    "attached: a frame naming no room is refused",
    parseServerToAgentMsg(JSON.stringify({ type: "attached", projectId: "" })) === null,
  );
  check(
    "adopt: a pid that is not a whole positive number is refused",
    parseServerToAgentMsg(JSON.stringify({ type: "adopt", pid: 0 })) === null &&
      parseServerToAgentMsg(JSON.stringify({ type: "adopt", pid: 4.5 })) === null,
  );
}

// ---------------------------------------------------------------------------
// 3. Browser link: browser → bridge
// ---------------------------------------------------------------------------

roundTrip(parseClientMsg, "diff", { type: "diff", worktree: WT2, revA: 1, revB: 4 });
roundTrip(parseClientMsg, "focus_terminal", { type: "focus_terminal", worktree: WT });
roundTrip(parseClientMsg, "switch_project", { type: "switch_project", path: "/elsewhere" }, { worktreeScoped: false });
roundTrip(parseClientMsg, "select_project", { type: "select_project", projectId: "k-1" }, { worktreeScoped: false });
// asking for the chooser carries nothing: the machine is the connection's
roundTrip(parseClientMsg, "pick_folder", { type: "pick_folder" }, { worktreeScoped: false });
roundTrip(parseClientMsg, "discover", { type: "discover" }, { worktreeScoped: false });
roundTrip(parseClientMsg, "adopt", { type: "adopt", pid: 4242 }, { worktreeScoped: false });

check(
  "client switch_project: the path is trimmed, and a blank one is refused",
  parseClientMsg(JSON.stringify({ type: "switch_project", path: "  /elsewhere  " }))?.path === "/elsewhere" &&
    parseClientMsg(JSON.stringify({ type: "switch_project", path: "   " })) === null,
);
check(
  "client select_project: a frame naming no room is refused",
  parseClientMsg(JSON.stringify({ type: "select_project", projectId: "" })) === null,
);
check(
  "client focus_terminal: a frame that names no variation is refused",
  parseClientMsg(JSON.stringify({ type: "focus_terminal" })) === null,
);
check(
  "client diff: a worktree alone is not a diff",
  parseClientMsg(JSON.stringify({ type: "diff", worktree: WT, revA: 1 })) === null,
);
check(
  "client adopt: a pid that is not a whole positive number is refused",
  parseClientMsg(JSON.stringify({ type: "adopt", pid: 0 })) === null &&
    parseClientMsg(JSON.stringify({ type: "adopt", pid: -1 })) === null,
);
// the two frames a steering, launching Shape took from the browser: this one
// has no reader for either, so they do not even parse
for (const [label, frame] of [
  ["utterance", { type: "utterance", worktree: WT, referent: null, text: "build it" }],
  ["open_worktree", { type: "open_worktree", path: WT2, backend: "omp" }],
]) {
  check(`client refuses ${label}: the browser cannot ask for a turn any more`, parseClientMsg(JSON.stringify(frame)) === null);
}

// ---------------------------------------------------------------------------
// 4. Storage: worktree-keyed rows
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "vh-wire-"));

{
  const storage = openSqliteStorage(join(dir, "fresh.db"));
  const doc = (rev, id) => ({ rev, nodes: [{ id, parentId: null, label: id, summary: "", phase: "idea" }], edges: [] });
  await storage.saveGraph("local", "k-1", WT, doc(1, "main-bubble"));
  await storage.saveGraph("local", "k-1", WT2, doc(2, "feature-bubble"));

  const onMain = await storage.loadGraph("local", "k-1", WT);
  const onFeature = await storage.loadGraph("local", "k-1", WT2);
  check(
    "two worktrees of one project keep two canvases",
    onMain?.nodes[0]?.id === "main-bubble" && onFeature?.nodes[0]?.id === "feature-bubble",
    JSON.stringify([onMain?.nodes[0]?.id, onFeature?.nodes[0]?.id]),
  );
  check("a worktree nobody drew on has no graph", (await storage.loadGraph("local", "k-1", "/repo/other")) === null);
  check("another tenant cannot read this worktree's graph", (await storage.loadGraph("other", "k-1", WT)) === null);

  await storage.saveRevision("local", "k-1", WT, { rev: 1, at: "2026-01-01T00:00:00.000Z", nodes: [], edges: [] });
  await storage.saveRevision("local", "k-1", WT, { rev: 2, at: "2026-01-01T00:01:00.000Z", nodes: [], edges: [] });
  await storage.saveRevision("local", "k-1", WT2, { rev: 9, at: "2026-01-01T00:02:00.000Z", nodes: [], edges: [] });
  const mainRevs = await storage.listRevisions("local", "k-1", WT);
  const featureRevs = await storage.listRevisions("local", "k-1", WT2);
  check(
    "revisions are listed per worktree",
    mainRevs.map((r) => r.rev).join() === "1,2" && featureRevs.map((r) => r.rev).join() === "9",
    JSON.stringify([mainRevs, featureRevs]),
  );
  check(
    "a rev of one worktree is not a rev of another",
    (await storage.loadRevision("local", "k-1", WT2, 1)) === null && (await storage.loadRevision("local", "k-1", WT, 1)) !== null,
  );
  check(
    "the same rev number may exist on two worktrees",
    (await storage.saveRevision("local", "k-1", WT2, { rev: 1, at: "2026-01-01T00:03:00.000Z", nodes: [], edges: [] })) === true,
  );

  await storage.saveProject({
    project: PROJECT,
    tenant: "local",
    worktrees: WORKTREES,
    sessions: [{ worktree: WT, session: SESSION, backend: BACKEND, state: "idle" }],
    lastSeen: "2026-01-01T00:00:00.000Z",
  });
  const rows = await storage.listProjects();
  check(
    "a registry row carries every worktree and every running harness",
    rows.length === 1 && rows[0].worktrees.length === 2 && rows[0].sessions[0]?.worktree === WT,
    JSON.stringify(rows[0]?.sessions),
  );

  // the only line a room writes by itself now: the skeleton it drew on an
  // empty canvas, and how many of its ops landed
  await storage.appendAudit("local", "k-1", WT2, {
    kind: "onboard",
    ops: 4,
    at: "2026-01-01T00:04:00.000Z",
    tenant: "local",
    projectId: "k-1",
    worktree: WT2,
  });
  storage.close();

  const db = new DatabaseSync(join(dir, "fresh.db"));
  const audit = db.prepare("SELECT worktree, entry FROM audit").all();
  check(
    "an audit line is filed against the worktree whose canvas it was written on",
    audit.length === 1 && audit[0].worktree === WT2 && JSON.parse(audit[0].entry).worktree === WT2,
    JSON.stringify(audit),
  );
  const version = db.prepare("PRAGMA user_version").get();
  check("a fresh database is written at schema 2", version.user_version === 2, JSON.stringify(version));
  db.close();
}

// ---------------------------------------------------------------------------
// 5. Storage: the v1 → v2 migration
// ---------------------------------------------------------------------------

{
  // the project's cwd must exist, because a worktree id is a realpath
  const cwd = mkdtempSync(join(tmpdir(), "vh-wire-repo-"));
  const real = realpathSync(cwd);
  const file = join(dir, "legacy.db");
  const old = new DatabaseSync(file);
  old.exec(`
CREATE TABLE projects (
  tenant     TEXT NOT NULL,
  key        TEXT NOT NULL,
  project    TEXT NOT NULL,
  session    TEXT NOT NULL,
  worktrees  TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (tenant, key)
);
CREATE TABLE graphs (
  tenant     TEXT NOT NULL,
  key        TEXT NOT NULL,
  doc        TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, key)
);
CREATE TABLE revisions (
  tenant   TEXT NOT NULL,
  key      TEXT NOT NULL,
  rev      INTEGER NOT NULL,
  at       TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (tenant, key, rev)
);
CREATE TABLE audit (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  key    TEXT NOT NULL,
  at     TEXT NOT NULL,
  entry  TEXT NOT NULL
);
`);
  old
    .prepare("INSERT INTO projects (tenant, key, project, session, worktrees, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "local",
      "k-old",
      JSON.stringify({ ...PROJECT, key: "k-old", cwd }),
      JSON.stringify(SESSION),
      JSON.stringify([{ path: cwd, branch: "main", head: "abc123", current: true }]),
      "2026-01-01T00:00:00.000Z",
    );
  old
    .prepare("INSERT INTO graphs (tenant, key, doc, updated_at) VALUES (?, ?, ?, ?)")
    .run("local", "k-old", JSON.stringify({ rev: 3, nodes: [{ id: "old-bubble" }], edges: [] }), "2026-01-01T00:00:00.000Z");
  // a graph whose registry row is gone: there is no cwd to resolve for it
  old
    .prepare("INSERT INTO graphs (tenant, key, doc, updated_at) VALUES (?, ?, ?, ?)")
    .run("local", "k-orphan", JSON.stringify({ rev: 1, nodes: [{ id: "orphan" }], edges: [] }), "2026-01-01T00:00:00.000Z");
  old
    .prepare("INSERT INTO revisions (tenant, key, rev, at, snapshot) VALUES (?, ?, ?, ?, ?)")
    .run("local", "k-old", 3, "2026-01-01T00:00:00.000Z", JSON.stringify({ rev: 3, at: "2026-01-01T00:00:00.000Z", nodes: [], edges: [] }));
  old
    .prepare("INSERT INTO audit (tenant, key, at, entry) VALUES (?, ?, ?, ?)")
    .run("local", "k-old", "2026-01-01T00:00:00.000Z", JSON.stringify({ kind: "onboard", ops: 2 }));
  old.exec("PRAGMA user_version = 1");
  old.close();

  const storage = openSqliteStorage(file);
  const migrated = await storage.loadGraph("local", "k-old", real);
  check(
    "a pre-worktree canvas is readable as the main worktree's",
    migrated?.nodes[0]?.id === "old-bubble",
    JSON.stringify(migrated),
  );
  check(
    "the migrated canvas is NOT readable under some other worktree",
    (await storage.loadGraph("local", "k-old", "/repo/feature")) === null,
  );
  const revs = await storage.listRevisions("local", "k-old", real);
  check("its revisions moved with it", revs.map((r) => r.rev).join() === "3", JSON.stringify(revs));
  const orphan = await storage.loadGraph("local", "k-orphan", "k-orphan");
  check(
    "a graph with no registry row falls back to the project key as its worktree",
    orphan?.nodes[0]?.id === "orphan",
    JSON.stringify(orphan),
  );

  const rows = await storage.listProjects();
  check(
    "a v1 registry row still parses after the migration",
    rows.length === 1 && rows[0].project.key === "k-old",
    JSON.stringify(rows.map((r) => r.project.key)),
  );
  check(
    "its worktree list gained ids and lost `current`",
    rows[0]?.worktrees[0]?.id === real && !("current" in (rows[0]?.worktrees[0] ?? {})),
    JSON.stringify(rows[0]?.worktrees),
  );
  check(
    "its single session became the main worktree's session",
    rows[0]?.sessions.length === 1 && rows[0].sessions[0].worktree === real && rows[0].sessions[0].session.sessionId === "s-1",
    JSON.stringify(rows[0]?.sessions),
  );

  // a write after the migration must land on the same row, not beside it
  await storage.saveGraph("local", "k-old", real, { rev: 4, nodes: [], edges: [] });
  storage.close();

  const db = new DatabaseSync(file);
  check("the migrated database reports schema 2", db.prepare("PRAGMA user_version").get().user_version === 2);
  check(
    "a post-migration save updates the migrated row instead of adding one",
    db.prepare("SELECT count(*) AS n FROM graphs WHERE tenant = ? AND key = ?").get("local", "k-old").n === 1,
  );
  const audit = db.prepare("SELECT seq, worktree, entry FROM audit").all();
  check(
    "old audit lines keep their sequence and gain their worktree",
    audit.length === 1 && audit[0].seq === 1 && audit[0].worktree === real && JSON.parse(audit[0].entry).worktree === real,
    JSON.stringify(audit),
  );
  db.close();

  // re-opening a database already at 2 must not migrate a second time
  const reopened = openSqliteStorage(file);
  const again = await reopened.loadGraph("local", "k-old", real);
  check("re-opening a migrated database is a no-op", again?.rev === 4, JSON.stringify(again));
  reopened.close();
}

// ---------------------------------------------------------------------------
// 6. Storage: adopting a canvas stored under an older project key
// ---------------------------------------------------------------------------

{
  const storage = openSqliteStorage(join(dir, "adopt.db"));
  const bubble = (id) => ({ id, parentId: null, label: id, summary: "", phase: "idea" });
  const line = (ops, key, worktree) => ({
    kind: "onboard",
    ops,
    at: "2026-01-01T00:00:00.000Z",
    tenant: "local",
    projectId: key,
    worktree,
  });
  const OLD = "k-legacy-main";
  const NEW = "k-1";

  // what the user drew before the project key came off the repo's common dir
  await storage.saveGraph("local", OLD, WT, { rev: 11, nodes: [bubble("drawn")], edges: [] });
  await storage.saveRevision("local", OLD, WT, { rev: 1, at: "2026-01-01T00:00:00.000Z", nodes: [bubble("drawn")], edges: [] });
  await storage.saveRevision("local", OLD, WT, { rev: 11, at: "2026-01-01T00:11:00.000Z", nodes: [bubble("drawn")], edges: [] });
  await storage.appendAudit("local", OLD, WT, line(3, OLD, WT));
  await storage.saveProject({
    project: { ...PROJECT, key: OLD, legacyKeys: {} },
    tenant: "local",
    worktrees: [WORKTREES[0]],
    sessions: [],
    lastSeen: "2026-01-01T00:00:00.000Z",
  });
  // and what the first attach on the new key wrote for the same worktree
  await storage.saveGraph("local", NEW, WT, { rev: 1, nodes: [], edges: [] });
  await storage.saveRevision("local", NEW, WT, { rev: 1, at: "2026-02-01T00:00:00.000Z", nodes: [], edges: [] });
  await storage.appendAudit("local", NEW, WT, line(1, NEW, WT));

  check(
    "a legacy key with nothing under it is nothing to adopt",
    (await storage.adoptLegacyKey("local", "k-never-used", NEW, WT)) === false,
  );
  check("a key cannot adopt from itself", (await storage.adoptLegacyKey("local", NEW, NEW, WT)) === false);
  check(
    "the legacy canvas of another worktree is not this worktree's to adopt",
    (await storage.adoptLegacyKey("local", OLD, NEW, WT2)) === false,
  );
  check("a canvas under an older project key is adopted", (await storage.adoptLegacyKey("local", OLD, NEW, WT)) === true);

  const graph = await storage.loadGraph("local", NEW, WT);
  check(
    "the canvas under the new key is the one the user drew",
    graph?.rev === 11 && graph?.nodes[0]?.id === "drawn",
    JSON.stringify(graph),
  );
  check("the legacy key no longer holds it", (await storage.loadGraph("local", OLD, WT)) === null);
  const revs = await storage.listRevisions("local", NEW, WT);
  check("its revisions moved with it", revs.map((r) => r.rev).join() === "1,11", JSON.stringify(revs));
  const rev1 = await storage.loadRevision("local", NEW, WT, 1);
  check(
    "rev 1 is the legacy history, not the empty canvas the new key opened at",
    rev1?.nodes.length === 1,
    JSON.stringify(rev1),
  );
  check("the legacy key keeps no revisions", (await storage.listRevisions("local", OLD, WT)).length === 0);
  check(
    "the legacy registry row is gone: one project, listed once",
    (await storage.listProjects()).every((row) => row.project.key !== OLD),
    JSON.stringify((await storage.listProjects()).map((row) => row.project.key)),
  );

  check("adopting again finds nothing left to move", (await storage.adoptLegacyKey("local", OLD, NEW, WT)) === false);
  const afterTwice = await storage.loadGraph("local", NEW, WT);
  check("and the adopted canvas is untouched by the second call", afterTwice?.nodes[0]?.id === "drawn", JSON.stringify(afterTwice));

  // a canvas somebody has already drawn under the CURRENT key wins
  const OLD2 = "k-legacy-feature";
  await storage.saveGraph("local", OLD2, WT2, { rev: 5, nodes: [bubble("legacy-feature")], edges: [] });
  await storage.saveGraph("local", NEW, WT2, { rev: 2, nodes: [bubble("drawn-since")], edges: [] });
  check("a non-empty canvas under the new key refuses the adoption", (await storage.adoptLegacyKey("local", OLD2, NEW, WT2)) === false);
  const kept = await storage.loadGraph("local", NEW, WT2);
  const spared = await storage.loadGraph("local", OLD2, WT2);
  check(
    "both canvases survive the refusal: neither is the other's to overwrite",
    kept?.nodes[0]?.id === "drawn-since" && spared?.nodes[0]?.id === "legacy-feature",
    JSON.stringify([kept?.nodes[0]?.id, spared?.nodes[0]?.id]),
  );

  // a legacy key that still holds another worktree's canvas keeps its row
  const OLD3 = "k-legacy-shared";
  const WT3 = "/repo/third";
  await storage.saveGraph("local", OLD3, WT2, { rev: 3, nodes: [bubble("shared-feature")], edges: [] });
  await storage.saveGraph("local", OLD3, WT3, { rev: 4, nodes: [bubble("shared-third")], edges: [] });
  await storage.saveProject({
    project: { ...PROJECT, key: OLD3, legacyKeys: {} },
    tenant: "local",
    worktrees: [WORKTREES[1]],
    sessions: [],
    lastSeen: "2026-01-01T00:00:00.000Z",
  });
  check("an empty canvas under the new key is replaced", (await storage.adoptLegacyKey("local", OLD3, "k-2", WT2)) === true);
  check(
    "a legacy key with a canvas left keeps its registry row",
    (await storage.listProjects()).some((row) => row.project.key === OLD3),
  );
  check("its last canvas adopts too", (await storage.adoptLegacyKey("local", OLD3, "k-2", WT3)) === true);
  check(
    "and then its registry row goes",
    (await storage.listProjects()).every((row) => row.project.key !== OLD3),
    JSON.stringify((await storage.listProjects()).map((row) => row.project.key)),
  );
  storage.close();

  const db = new DatabaseSync(join(dir, "adopt.db"));
  const audit = db.prepare("SELECT key, worktree, entry FROM audit WHERE worktree = ? ORDER BY seq ASC").all(WT);
  check(
    "the audit lines moved to the new key and were re-stamped with it",
    audit.length === 2 &&
      audit.every((row) => row.key === NEW) &&
      audit.every((row) => JSON.parse(row.entry).projectId === NEW) &&
      audit.map((row) => JSON.parse(row.entry).ops).join() === "3,1",
    JSON.stringify(audit),
  );
  db.close();
}

// ---------------------------------------------------------------------------
// 7. Loopback link: harness-side process → agent
// ---------------------------------------------------------------------------

const CWD = "/repo/main";
const MODEL = { provider: "fake", id: "fake-1" };

/**
 * The loopback twin of `roundTrip`: these frames are placed by the `cwd` the
 * caller runs in, not by a worktree id, and one without a cwd cannot be
 * attributed to a harness at all.
 */
function linkTrip(label, frame) {
  const parsed = parseLinkMsg(JSON.stringify(frame));
  check(`${label}: accepted`, parsed !== null, "validator returned null");
  if (parsed !== null) {
    check(`${label}: survives the round trip unchanged`, JSON.stringify(parsed) === JSON.stringify(frame), JSON.stringify(parsed));
  }
  const { cwd: _dropped, ...without } = frame;
  check(`${label}: refused without a cwd`, parseLinkMsg(JSON.stringify(without)) === null);
  check(`${label}: refused with an empty cwd`, parseLinkMsg(JSON.stringify({ ...frame, cwd: "" })) === null);
}

const HELLO = {
  type: "hello",
  cwd: CWD,
  harness: "omp",
  sessionId: "s-1",
  sessionFile: "/tmp/fake/s-1.jsonl",
  model: MODEL,
  capabilities: { steer: true, tool: true },
};

linkTrip("link hello", HELLO);
linkTrip("link hello before the harness resolved anything", { ...HELLO, sessionId: null, sessionFile: null, model: null });
linkTrip("link canvas_call", { type: "canvas_call", cwd: CWD, id: "c-1", args: { ops: [] } });
linkTrip("link agent_event text", { type: "agent_event", cwd: CWD, event: { kind: "text", text: "the login part is done." } });
linkTrip("link agent_event text_delta", { type: "agent_event", cwd: CWD, event: { kind: "text_delta", delta: "the login" } });
linkTrip("link agent_event session", {
  type: "agent_event",
  cwd: CWD,
  event: { kind: "session", sessionId: "s-1", sessionFile: "/tmp/fake/s-1.jsonl", model: MODEL },
});
// a harness on an older Shape integration still acknowledges what it was
// given; the frame parses, and the block below is what the agent does with it
linkTrip("link delivered", { type: "delivered", cwd: CWD, id: "d-1", mode: "steer", queued: false });
linkTrip("link bye", { type: "bye", cwd: CWD, reason: "the user quit the tui" });

{
  // a harness that keeps no transcript on disk has no file to name, and says so
  // by leaving the field out: the same answer as an explicit null
  const noFile = parseLinkMsg(
    JSON.stringify({ type: "agent_event", cwd: CWD, event: { kind: "session", sessionId: "s-2", model: null } }),
  );
  check(
    "session: an absent session file is accepted and normalized to null",
    noFile?.event.kind === "session" && noFile.event.sessionId === "s-2" && noFile.event.sessionFile === null,
    JSON.stringify(noFile),
  );
  const refusals = [
    ["hello with no capabilities", { type: "hello", cwd: CWD, harness: "omp", sessionId: null, sessionFile: null, model: null }],
    ["hello with half a capability set", { ...HELLO, capabilities: { steer: true } }],
    ["hello with a non-boolean capability", { ...HELLO, capabilities: { steer: "yes", tool: true } }],
    ["hello with no harness", { ...HELLO, harness: "" }],
    ["hello with a malformed model", { ...HELLO, model: { provider: "fake" } }],
    ["hello with a non-string session file", { ...HELLO, sessionFile: 7 }],
    ["delivered with an unknown mode", { type: "delivered", cwd: CWD, id: "d-1", mode: "shout", queued: false }],
    ["delivered with no queued flag", { type: "delivered", cwd: CWD, id: "d-1", mode: "prompt" }],
    ["delivered with an empty id", { type: "delivered", cwd: CWD, id: "", mode: "prompt", queued: true }],
    ["bye with no reason", { type: "bye", cwd: CWD }],
    ["a text_delta that is not text", { type: "agent_event", cwd: CWD, event: { kind: "text_delta", delta: 7 } }],
    ["a session with a non-string file", { type: "agent_event", cwd: CWD, event: { kind: "session", sessionId: "s", sessionFile: 7, model: null } }],
    ["a frame of no known type", { type: "hello_there", cwd: CWD }],
  ];
  for (const [label, frame] of refusals) {
    check(`link refuses ${label}`, parseLinkMsg(JSON.stringify(frame)) === null, JSON.stringify(frame));
  }
}

{
  // The receipt, routed for real. Shape sends nothing to acknowledge any more,
  // so the frame has no reader — and refusing it would come back at the
  // harness as an `error` it did not earn. It is dropped in silence.
  const touched = [];
  const events = new Proxy(
    {},
    { get: (_sink, name) => (arg) => touched.push(`${String(name)}:${JSON.stringify(arg ?? null)}`) },
  );
  const target = {
    applyCanvas: async (args) => {
      touched.push(`applyCanvas:${JSON.stringify(args ?? null)}`);
      return { text: "", isError: false };
    },
    events,
    onHello: () => touched.push("onHello"),
    onBye: () => touched.push("onBye"),
  };
  const io = new ExternalIo({ route: (cwd) => (cwd === CWD ? target : { error: `no session in ${cwd}` }) });
  const replies = [];
  const reply = (msg) => replies.push(msg);
  io.handle(parseLinkMsg(JSON.stringify({ type: "delivered", cwd: CWD, id: "d-1", mode: "prompt", queued: true })), reply);
  check(
    "a receipt for a prompt nobody sent is answered with nothing, and touches no session",
    replies.length === 0 && touched.length === 0,
    JSON.stringify({ replies, touched }),
  );
  io.handle(parseLinkMsg(JSON.stringify({ type: "bye", cwd: CWD, reason: "the user quit" })), reply);
  check("the same route does hear a bye, so the silence above was the receipt's own", touched.join() === "onBye", touched.join());
}

// ---------------------------------------------------------------------------
// 8. The fakes, for real: fake-omp-tui on a bare link
// ---------------------------------------------------------------------------

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** poll until `fn` answers; what was waited for is itself a check, either way */
async function waitFor(label, fn, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = fn();
    if (hit) {
      check(label, true);
      return hit;
    }
    if (Date.now() > deadline) {
      check(label, false, "timed out");
      return null;
    }
    await sleep(20);
  }
}

/** a fake's JSONL log, in order */
function jsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * The agent end, as far as a harness on the link can tell: every frame is read
 * back through the REAL validator, so a fake that drifts out of the protocol
 * fails here rather than in the smoke that trusted it.
 */
const linkServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(linkServer, "listening");
const LINK_URL = `ws://127.0.0.1:${linkServer.address().port}/link`;
const linkFrames = [];
const unparseable = [];
const canvasCalls = [];
linkServer.on("connection", (socket) => {
  socket.on("message", (data) => {
    const frame = parseLinkMsg(data.toString());
    if (frame === null) {
      unparseable.push(data.toString());
      return;
    }
    linkFrames.push(frame);
    if (frame.type === "canvas_call") {
      canvasCalls.push(frame);
      const ops = Array.isArray(frame.args?.ops) ? frame.args.ops.length : 0;
      socket.send(JSON.stringify({ type: "canvas_result", id: frame.id, text: `applied ${ops} op(s);`, isError: false }));
    }
  });
});

const TUI = join(SCRIPTS, "fake-omp-tui.mjs");
const eventsIn = (cwd) => linkFrames.filter((f) => f.cwd === cwd && f.type === "agent_event").map((f) => f.event);

{
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "vh-tui-")));
  const log = join(wt, "fake-omp.log");
  const child = spawn(process.execPath, [TUI, "--resume", "r-42"], {
    cwd: wt,
    env: { ...process.env, SHAPE_LINK: LINK_URL, SHAPE_WORKTREE: wt, FAKE_OMP_LOG: log },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const hello = await waitFor("fake-omp-tui announces itself with hello", () =>
    linkFrames.find((f) => f.cwd === wt && f.type === "hello"),
  );
  check(
    "hello names the harness, the session it resumed and the file it logs to",
    hello?.harness === "omp" && hello?.sessionId === "r-42" && hello?.sessionFile?.endsWith("r-42.jsonl") === true,
    JSON.stringify(hello),
  );
  check(
    "hello says what the session can be asked to do, and which model it is on",
    hello?.capabilities.steer === true && hello?.capabilities.tool === true && hello?.model?.id === "fake-1",
    JSON.stringify(hello?.capabilities),
  );

  // a turn starts where every turn starts now: the user typing into the pane
  child.stdin.write(`${JSON.stringify({ type: "typed", text: "build me an auth service" })}\n`);

  const turn = await waitFor("the typed prompt runs a turn to its end", () => {
    const kinds = eventsIn(wt).map((e) => e.kind);
    return kinds.includes("turn_end") && kinds.at(-1) === "state" ? eventsIn(wt) : null;
  });
  const kinds = (turn ?? []).map((e) => e.kind);
  check("the session is announced as an event too, for adapters that only take events", kinds[0] === "session", kinds.join());
  check("the turn opens on streaming and closes on idle", turn?.[1]?.state === "streaming" && turn?.at(-1)?.state === "idle", kinds.join());
  check("the message arrives as deltas first, then as one whole text", kinds.filter((k) => k === "text_delta").length >= 2 && kinds.includes("text"), kinds.join());
  check(
    "the whole text is what the deltas spelled",
    turn?.find((e) => e.kind === "text")?.text === turn?.filter((e) => e.kind === "text_delta").map((e) => e.delta).join(""),
    JSON.stringify(turn?.find((e) => e.kind === "text")?.text),
  );
  const toolStart = turn?.find((e) => e.kind === "tool_start");
  check(
    "the tool pair carries a path, so activity mapping has something to match",
    toolStart?.paths?.[0] === "packages/auth/src/index.ts" && kinds.includes("tool_end"),
    JSON.stringify(toolStart),
  );
  check("turn_end comes before the session goes idle", kinds.indexOf("turn_end") === kinds.length - 2, kinds.join());

  const call = canvasCalls.find((c) => c.cwd === wt);
  check(
    "the turn writes to the canvas with the ops the prompt asks for",
    call?.args?.ops?.length === 3 && call?.args?.note === "initial decomposition",
    JSON.stringify(call?.args?.note),
  );
  check("every frame the fake sent is one the agent's own validator accepts", unparseable.length === 0, unparseable.join(" | "));

  await waitFor("the typed line is recorded on the fake's log", () =>
    jsonl(log).some((f) => f.type === "typed" && f.__dir === "stdin"),
  );
  const logged = jsonl(log);
  const started = logged.find((f) => f.type === "__start");
  check(
    "the log opens with the child, its argv and the link it dialled",
    started?.argv.join(" ") === "--resume r-42" && started?.cwd === wt && started?.link === LINK_URL,
    JSON.stringify(started),
  );
  check(
    "the log keeps both directions, one frame per line",
    logged.some((f) => f.type === "hello" && f.__dir === "out") &&
      logged.some((f) => f.type === "canvas_result" && f.__dir === "in"),
    logged.map((f) => `${f.type}/${f.__dir ?? "-"}`).join(),
  );

  child.kill("SIGTERM");
  const farewell = await waitFor("SIGTERM makes the session say bye", () => linkFrames.find((f) => f.cwd === wt && f.type === "bye"));
  check("bye says why the session went away", typeof farewell?.reason === "string" && farewell.reason.length > 0, JSON.stringify(farewell));
  await once(child, "exit");
  check("the log closes on an exit marker", jsonl(log).some((f) => f.type === "__exit"));
}

// ---------------------------------------------------------------------------
// 9. The fakes, for real: fake-herdr over its socket
// ---------------------------------------------------------------------------

/** every request this smoke sends, so herdr's log can be read back in order */
let herdrSeq = 0;

/**
 * One call on its own connection, which is all herdr's server gives: it
 * answers a plain request with ONE line and then hangs up. `hungUp` reports
 * that close, because a client that assumed otherwise is the bug this covers.
 */
function herdrCall(path, method, params) {
  const socket = createConnection(path);
  const { promise, resolve } = Promise.withResolvers();
  let buf = "";
  let answer = null;
  let settled = false;
  const settle = (hungUp) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve({ ...(answer ?? { error: { code: "no_answer", message: "herdr closed without answering" } }), hungUp });
  };
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ id: `q-${++herdrSeq}`, method, params })}\n`);
  });
  socket.on("data", (chunk) => {
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl < 0 || answer !== null) return;
    answer = JSON.parse(buf.slice(0, nl));
  });
  socket.on("close", () => settle(true));
  socket.on("error", () => settle(true));
  // a server that answers and keeps the connection is a finding, not a hang
  setTimeout(() => settle(false), 10_000).unref();
  return promise;
}

/**
 * A subscription connection: answered once with `subscription_started` and
 * then left open, carrying the unsolicited event envelopes.
 */
function herdrStream(path, subscriptions) {
  const socket = createConnection(path);
  const events = [];
  const { promise, resolve } = Promise.withResolvers();
  let buf = "";
  let answered = false;
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ id: `sub-${++herdrSeq}`, method: "events.subscribe", params: { subscriptions } })}\n`);
  });
  socket.on("data", (chunk) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line.length === 0) continue;
      const msg = JSON.parse(line);
      if ("event" in msg) {
        events.push(msg);
        continue;
      }
      if (answered) continue;
      answered = true;
      resolve(msg);
    }
  });
  socket.on("close", () => {
    if (answered) return;
    answered = true;
    resolve({ error: { code: "no_answer", message: "herdr closed the subscription" } });
  });
  return { socket, events, answer: promise };
}

{
  const home = realpathSync(mkdtempSync(join(tmpdir(), "vh-herdr-")));
  const socketPath = join(home, "herdr.sock");
  const log = join(home, "fake-herdr.log");
  const herdr = spawn(process.execPath, [join(SCRIPTS, "fake-herdr.mjs")], {
    cwd: home,
    env: { ...process.env, HERDR_SOCKET_PATH: socketPath, FAKE_HERDR_LOG: log },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let said = "";
  herdr.stdout.setEncoding("utf8");
  herdr.stdout.on("data", (chunk) => {
    said += chunk;
  });
  await waitFor("fake-herdr says it is listening", () => said.includes('"ready"') && existsSync(socketPath));

  const snapshot = await herdrCall(socketPath, "session.snapshot", {});
  check(
    "session.snapshot answers with the protocol it speaks and the workspaces already open (a herdr somebody has used)",
    snapshot.result?.snapshot.protocol === 19 &&
      snapshot.result?.snapshot.workspaces.length === 1 &&
      snapshot.result?.snapshot.workspaces[0].label === "scratch",
    JSON.stringify(snapshot.error ?? snapshot.result?.snapshot.workspaces),
  );
  check(
    "and the server hangs up on its answer: a plain call is one exchange on one connection",
    snapshot.hungUp === true,
    JSON.stringify(snapshot.hungUp),
  );

  // the lifecycle events are the global ones, and their connection stays open
  const lifecycle = herdrStream(socketPath, [{ type: "pane.exited" }, { type: "pane.closed" }]);
  const subscribed = await lifecycle.answer;
  check(
    "events.subscribe answers subscription_started and keeps that connection",
    subscribed.result?.type === "subscription_started",
    JSON.stringify(subscribed),
  );
  const unscoped = await herdrCall(socketPath, "events.subscribe", {
    subscriptions: [{ type: "pane.agent_status_changed" }],
  });
  check(
    "a pane's status cannot be subscribed globally: it is refused for the missing pane_id",
    unscoped.error?.code === "invalid_request" && unscoped.error.message.includes("pane_id"),
    JSON.stringify(unscoped),
  );

  const wt = realpathSync(mkdtempSync(join(tmpdir(), "vh-herdr-wt-")));
  const created = await herdrCall(socketPath, "tab.create", {
    cwd: wt,
    label: "shape-main",
    env: { SHAPE_LINK: LINK_URL, SHAPE_WORKTREE: wt, FAKE_OMP_LOG: join(wt, "fake-omp.log") },
    focus: false,
  });
  const pane = created.result?.root_pane.pane_id;
  check(
    "tab.create hands back a tab and the pane a harness can be started in",
    typeof created.result?.tab.tab_id === "string" && typeof pane === "string" && created.result.root_pane.cwd === wt,
    JSON.stringify(created.error ?? created.result),
  );

  // status is per pane, so the connection that carries it names the pane
  const status = herdrStream(socketPath, [{ type: "pane.agent_status_changed", pane_id: pane }]);
  const watching = await status.answer;
  check(
    "a pane's status is subscribed for THAT pane, on a connection of its own",
    watching.result?.type === "subscription_started",
    JSON.stringify(watching),
  );

  const startedAgent = await herdrCall(socketPath, "agent.start", { name: "shape-main-1", kind: "omp", pane_id: pane, args: ["--resume", "r-7"] });
  const agent = startedAgent.result?.agent;
  check(
    "agent.start answers with the agent record for that pane",
    agent?.pane_id === pane && agent?.agent === "omp" && agent?.agent_status === "idle",
    JSON.stringify(startedAgent.error ?? agent),
  );
  check(
    "the record names the session file the harness reported, the way herdr does",
    agent?.agent_session?.kind === "path" && agent?.agent_session?.value.endsWith("r-7.jsonl") === true,
    JSON.stringify(agent?.agent_session),
  );
  // global by protocol: every pane with a live harness in it, whoever started
  // it, which is how the agent finds the pane a worktree's session runs in
  const listed = await herdrCall(socketPath, "agent.list", {});
  const row = listed.result?.agents?.find((a) => a.pane_id === pane);
  check(
    "agent.list answers rows naming the pane, its tab and workspace, and the cwd a session is matched on",
    row?.tab_id === created.result.tab.tab_id && typeof row?.workspace_id === "string" && row?.cwd === wt,
    JSON.stringify(listed.error ?? listed.result?.agents),
  );

  const prompted = await herdrCall(socketPath, "agent.prompt", { target: "shape-main-1", text: "next probe" });
  check("agent.prompt submits into the pane", prompted.result?.submitted === true, JSON.stringify(prompted.error ?? prompted.result));

  await waitFor(
    "the status stream reports the turn, working then idle",
    () =>
      status.events.some((e) => e.event === "pane.agent_status_changed" && e.data.agent_status === "working") &&
      status.events.some((e) => e.event === "pane.agent_status_changed" && e.data.agent_status === "idle"),
  );
  check(
    "a status event names the pane and the agent it is about",
    status.events.find((e) => e.event === "pane.agent_status_changed")?.data.pane_id === pane,
    JSON.stringify(status.events[0]),
  );

  const focused = await herdrCall(socketPath, "agent.focus", { target: "shape-main-1" });
  check("agent.focus is answered for a live agent", focused.result?.focused === true, JSON.stringify(focused.error ?? focused.result));
  const tabFocused = await herdrCall(socketPath, "tab.focus", { tab_id: created.result.tab.tab_id });
  check("tab.focus is answered for a live tab", tabFocused.result?.focused === true, JSON.stringify(tabFocused.error ?? tabFocused.result));
  const missing = await herdrCall(socketPath, "agent.focus", { target: "nobody" });
  check("a call about an agent that is not there fails with a code", missing.error?.code === "agent_not_found", JSON.stringify(missing));

  const closed = await herdrCall(socketPath, "tab.close", { tab_id: created.result.tab.tab_id });
  check("tab.close closes the tab", closed.result?.closed === true, JSON.stringify(closed.error ?? closed.result));
  const farewell = await waitFor("closing the tab ends the harness session", () => linkFrames.find((f) => f.cwd === wt && f.type === "bye"));
  check("the closed pane's harness said bye on its way out", typeof farewell?.reason === "string", JSON.stringify(farewell));
  await waitFor("pane.exited is streamed for the closed pane", () =>
    lifecycle.events.some((e) => e.event === "pane.exited" && e.data.pane_id === pane),
  );

  const methods = jsonl(log)
    .filter((f) => f.type === "__call")
    .map((f) => f.method);
  check(
    "every call is recorded, in the order it arrived",
    methods.join() ===
      "session.snapshot,events.subscribe,events.subscribe,tab.create,events.subscribe,agent.start,agent.list,agent.prompt,agent.focus,tab.focus,agent.focus,tab.close",
    methods.join(),
  );
  check(
    "the recorded tab.create keeps the env the launcher asked for",
    jsonl(log).find((f) => f.type === "__call" && f.method === "tab.create")?.params.env.SHAPE_LINK === LINK_URL,
  );
  const plainCalls = jsonl(log).filter((f) => f.type === "__call" && f.method !== "events.subscribe");
  check(
    "and each of them arrived on a connection of its own",
    new Set(plainCalls.map((f) => f.conn)).size === plainCalls.length,
    `${plainCalls.length} calls on ${new Set(plainCalls.map((f) => f.conn)).size} connections`,
  );

  lifecycle.socket.destroy();
  status.socket.destroy();
  herdr.kill("SIGTERM");
  await once(herdr, "exit");
}

// ---------------------------------------------------------------------------
// 10. Which terminal application hosts the herdr client
// ---------------------------------------------------------------------------
// Focusing a herdr tab is invisible unless the terminal APP comes forward too,
// and which app that is comes out of the process table: the client's parent
// chain walked to the first `.app`. The table below is the real shape of this
// machine (herdr <- zsh <- login <- Ghostty.app) with the server and an
// unrelated Chrome tree next to it, because both are what the walk must ignore.

{
  const table = [
    "  PID  PPID COMMAND",
    " 1710     1 /Applications/Ghostty.app/Contents/MacOS/ghostty",
    " 1717  1710 login -fp orgal",
    " 1719  1717 -/bin/zsh",
    " 1757  1719 herdr",
    "56037     1 /Users/orgal/.local/bin/herdr server",
    "  900     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "  901   900 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer",
  ].join("\n");
  const rows = parsePsRows(table);
  check(
    "ps rows parse to pid, ppid and the whole command line",
    // seven rows, not eight: the `PID PPID COMMAND` header is not a process
    rows.length === 7 &&
      rows[0].pid === 1710 &&
      rows[0].ppid === 1 &&
      rows[0].command === "/Applications/Ghostty.app/Contents/MacOS/ghostty" &&
      rows[4].command === "/Users/orgal/.local/bin/herdr server" &&
      // spaces and flags inside the command line survive the two-token split
      rows[6].command === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer",
    JSON.stringify(rows),
  );
  check(
    "the terminal hosting the herdr client is the first .app up its parent chain",
    terminalAppOf(rows) === "/Applications/Ghostty.app",
    String(terminalAppOf(rows)),
  );
  check(
    "a machine running only the herdr SERVER has no terminal to raise",
    terminalAppOf(parsePsRows([" 1710     1 /Applications/Ghostty.app/Contents/MacOS/ghostty", "56037     1 /Users/orgal/.local/bin/herdr server"].join("\n"))) === null,
  );
  check(
    "a client whose chain ends at pid 1 with no bundle (ssh, tmux, a bare console) has none either",
    terminalAppOf(
      parsePsRows(["  500     1 /usr/bin/tmux", "  501   500 -/bin/zsh", "  502   501 herdr --session shape"].join("\n")),
    ) === null,
  );
  check(
    "a subcommand client is still the client",
    terminalAppOf(parsePsRows([" 1710     1 /Applications/Ghostty.app/Contents/MacOS/ghostty", " 1719  1710 -/bin/zsh", " 1757  1719 herdr session attach main"].join("\n"))) ===
      "/Applications/Ghostty.app",
  );
  check(
    "the client rule: the interactive client, never the server or a query",
    isHerdrClient("herdr") &&
      isHerdrClient("herdr --session shape") &&
      isHerdrClient("herdr session attach main") &&
      isHerdrClient("/Users/orgal/.local/bin/herdr --remote host") &&
      !isHerdrClient("herdr server") &&
      !isHerdrClient("/Users/orgal/.local/bin/herdr server") &&
      !isHerdrClient("herdr api snapshot") &&
      !isHerdrClient("herdr status") &&
      !isHerdrClient("herdrctl") &&
      !isHerdrClient("node scripts/fake-herdr.mjs"),
  );
  // a table that names a parent that has already been reused must not spin
  check(
    "a parent cycle in a table read while processes came and went terminates",
    terminalAppOf(parsePsRows(["  10    11 herdr", "  11    10 -/bin/zsh"].join("\n"))) === null,
  );
}

linkServer.close();

console.log(`\n${results.join("\n")}\n`);
console.log(failed === 0 ? `WIRE SMOKE OK (${results.length} checks)` : `WIRE SMOKE FAILED (${failed}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
