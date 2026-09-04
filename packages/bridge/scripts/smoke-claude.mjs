#!/usr/bin/env node
/**
 * Claude Code adapter smoke test. Three layers, no network and no model:
 *
 *  1. the adapter in-process: what it can do, and the exact argv it builds
 *     (the inline link MCP config, the hook settings, approvals, resume)
 *  2. PtyManager.attach: the terminal drawer wired to a harness's own TUI
 *     instead of a shell, driven through a stub terminal source
 *  3. the real bridge launching scripts/fake-claude.mjs as an interactive TUI
 *     under the pty launcher: the argv it was started with, the paste an
 *     utterance arrives as, the keystroke an abort arrives as, and the events
 *     that come back through the link's hook script — which is the only way
 *     Shape ever hears about a Claude Code session.
 *
 * Usage (from packages/bridge): node scripts/smoke-claude.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const PORT = Number(process.env.SMOKE_CLAUDE_PORT ?? 4403);

// Claude Code is a TUI: Shape launches it in a terminal and types at it. Here
// that terminal is Shape's own pty, and the one harness this machine reports is
// claude — nothing about this smoke may depend on what is really installed.
process.env.SHAPE_LAUNCHER = "pty";
process.env.SHAPE_FORCE_HARNESSES = "claude";

const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = predicate();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(20);
  }
}

/** the index of `flag` in argv, or -1; `argv[i + 1]` is its value */
const flagAt = (argv, flag) => argv.indexOf(flag);

const REPO_ROOT = resolve(process.cwd(), "..", "..");
const LINK_MCP = join(REPO_ROOT, "packages", "link", "src", "mcp.ts");
const LINK_HOOK = join(REPO_ROOT, "packages", "link", "src", "hook.ts");
// what the runtime hands a backend: its own loopback link endpoint, not the
// browser hub — the MCP server and the hooks talk agent frames, not client ones
const LINK_URL = `ws://127.0.0.1:${String(PORT)}/link`;

// ---------------------------------------------------------------------------
// 1. the adapter in-process: capabilities and argv
// ---------------------------------------------------------------------------

const { ClaudeBackend } = await import(new URL("../src/agent/backend/claude.ts", import.meta.url));

{
  const claude = new ClaudeBackend({ command: ["claude"] });
  check(
    "claude reports what it can do: hooks for events, no mid-turn steering, resumable",
    claude.capabilities.events === "hooks" && claude.capabilities.steerMidTurn === false &&
      claude.capabilities.resume === true && claude.capabilities.hostTool === true,
    JSON.stringify(claude.capabilities),
  );
  check(
    "and a terminal Shape can take the user to",
    claude.capabilities.terminal === "pane" || claude.capabilities.terminal === "external",
    String(claude.capabilities.terminal),
  );
  check("id/label are the wire identity of the harness", claude.id === "claude" && claude.label === "Claude Code");
}

{
  const claude = new ClaudeBackend({
    command: ["claude", "--model", "opus"],
    args: ["--add-dir", "/tmp"],
    permissionMode: "acceptEdits",
  });
  const argv = claude.argv({ linkUrl: LINK_URL, autonomous: false, resumeSessionId: "sess-7" });
  check(
    "argv opens with the configured command and ends with the configured extra args",
    argv[0] === "claude" && argv[1] === "--model" && argv[2] === "opus" &&
      argv.slice(-2).join(" ") === "--add-dir /tmp",
    argv.join(" "),
  );
  check(
    "argv is interactive: none of the headless stream-json contract survives",
    flagAt(argv, "-p") === -1 && flagAt(argv, "--input-format") === -1 && flagAt(argv, "--output-format") === -1 &&
      flagAt(argv, "--verbose") === -1 && flagAt(argv, "--include-partial-messages") === -1,
    argv.join(" "),
  );
  check(
    "argv allows exactly the link's canvas tool and asks for the configured approvals",
    argv[flagAt(argv, "--allowedTools") + 1] === "mcp__shape__canvas" &&
      argv[flagAt(argv, "--permission-mode") + 1] === "acceptEdits" &&
      flagAt(argv, "--dangerously-skip-permissions") === -1,
    argv.join(" "),
  );
  check("argv resumes the session being adopted", argv[flagAt(argv, "--resume") + 1] === "sess-7", argv.join(" "));

  const mcp = JSON.parse(argv[flagAt(argv, "--mcp-config") + 1]);
  check(
    "the inline --mcp-config launches the link's MCP server at this agent's loopback link",
    mcp.mcpServers.shape.args[0] === LINK_MCP && mcp.mcpServers.shape.env.SHAPE_BRIDGE_URL === LINK_URL &&
      mcp.mcpServers.shape.command.length > 0,
    JSON.stringify(mcp),
  );

  const settings = JSON.parse(argv[flagAt(argv, "--settings") + 1]);
  const events = Object.keys(settings.hooks).sort().join(",");
  check(
    "--settings wires every hook the link maps to an agent_event",
    events === "PostToolUse,PreToolUse,SessionStart,Stop,UserPromptSubmit",
    events,
  );
  const hook = settings.hooks.PreToolUse[0].hooks[0];
  check(
    "each hook runs the link's hook script with this agent's link url in its env",
    hook.type === "command" && hook.command.includes(LINK_HOOK) &&
      hook.command.startsWith(`SHAPE_BRIDGE_URL='${LINK_URL}'`),
    hook.command,
  );
  check(
    "tool hooks match every tool; session hooks take no matcher",
    settings.hooks.PreToolUse[0].matcher === "*" && settings.hooks.Stop[0].matcher === undefined,
    JSON.stringify(settings.hooks.Stop),
  );

  const wild = new ClaudeBackend({ command: ["claude"] }).argv({ linkUrl: LINK_URL, autonomous: true });
  check(
    "a session started autonomous launches with approvals turned off, and asks for no mode",
    flagAt(wild, "--dangerously-skip-permissions") !== -1 && flagAt(wild, "--permission-mode") === -1,
    wild.join(" "),
  );
  check("nothing is resumed when nothing is being adopted", flagAt(wild, "--resume") === -1, wild.join(" "));

  let threw = "";
  try {
    await new ClaudeBackend({ command: ["claude"] }).setAutonomous(true);
  } catch (err) {
    threw = String(err.message ?? err);
  }
  check(
    "approvals cannot be turned off mid-session: that is a launch-time choice, and it says so",
    threw.includes("start it again"),
    threw,
  );
}

// ---------------------------------------------------------------------------
// 2. PtyManager.attach: the drawer on a harness TUI
// ---------------------------------------------------------------------------

{
  const { PtyManager } = await import(new URL("../src/agent/pty.ts", import.meta.url));
  const sent = [];
  // a pane belongs to one worktree and stamps it on every frame; the smoke's
  // own directory stands in for one here
  const paneWt = realpathSync(process.cwd());
  const pty = new PtyManager({ worktree: paneWt, cwd: process.cwd(), broadcast: (msg) => sent.push(msg) });

  const source = {
    written: [],
    sizes: [],
    dataCb: null,
    exitCb: null,
    write(data) {
      this.written.push(data);
    },
    resize(cols, rows) {
      this.sizes.push(`${cols}x${rows}`);
    },
    onData(cb) {
      this.dataCb = cb;
      return () => {
        this.dataCb = null;
      };
    },
    onExit(cb) {
      this.exitCb = cb;
      return () => {
        this.exitCb = null;
      };
    },
  };

  pty.attach(source);
  const attached = sent.at(-1);
  check(
    "attach announces an open pane labelled as the agent, not a shell",
    attached.type === "pty_state" && attached.open === true && attached.shell === "agent",
    JSON.stringify(attached),
  );

  pty.handle({ type: "pty_open", worktree: paneWt, cols: 100, rows: 40 });
  check(
    "pty_open joins the running TUI at the browser's size instead of spawning a shell",
    source.sizes.join(",") === "100x40" && sent.at(-1).open === true,
    JSON.stringify(source.sizes),
  );

  pty.handle({ type: "pty_input", worktree: paneWt, data: "hello" });
  pty.handle({ type: "pty_resize", worktree: paneWt, cols: 90, rows: 30 });
  pty.handle({ type: "pty_close", worktree: paneWt });
  check("pty_input reaches the TUI", source.written.join("") === "hello", JSON.stringify(source.written));
  check("pty_resize reaches the TUI", source.sizes.join(",") === "100x40,90x30", JSON.stringify(source.sizes));
  check("pty_close is a no-op: the agent is not closable from the pane", sent.at(-1).open === true);

  source.dataCb("line-1");
  source.dataCb("line-2");
  await sleep(30);
  const data = sent.filter((m) => m.type === "pty_data");
  check(
    "TUI output is batched onto the wire the same way shell output is",
    data.length === 1 && data[0].data === "line-1line-2",
    JSON.stringify(data),
  );

  source.exitCb(0);
  const exit = sent.filter((m) => m.type === "pty_exit").at(-1);
  check(
    "the TUI exiting closes the pane",
    exit !== undefined && exit.code === 0 && sent.at(-1).type === "pty_state" && sent.at(-1).open === false,
    JSON.stringify([exit, sent.at(-1)]),
  );

  pty.attach(null);
  const back = sent.at(-1);
  check(
    "attach(null) returns the pane to shell mode without starting one",
    back.type === "pty_state" && back.open === false && back.shell !== "agent",
    JSON.stringify(back),
  );
  check("detaching unsubscribes from the source", source.dataCb === null && source.exitCb === null);
  pty.dispose();
}

// ---------------------------------------------------------------------------
// 3. the real bridge launching the fake claude as a TUI
// ---------------------------------------------------------------------------

const target = await mkdtemp(join(tmpdir(), "vh-claude-"));
const fakeHome = await mkdtemp(join(tmpdir(), "vh-claude-home-"));
const fakeClaude = resolve(process.cwd(), "scripts", "fake-claude.mjs");
const claudeLog = join(target, "fake-claude.log");
// the id every worktree-scoped frame names: a macOS temp dir is reached through
// a symlink, and the bridge keys each canvas by the worktree's realpath
const mainWt = realpathSync(target);

// a committed workspace: gives the bridge a real git HEAD, so the reality
// refresh on turn end has something to derive
await mkdir(join(target, "packages", "auth", "src"), { recursive: true });
await writeFile(join(target, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
await writeFile(join(target, "package.json"), JSON.stringify({ name: "c", private: true }));
await writeFile(join(target, "packages", "auth", "package.json"), JSON.stringify({ name: "@c/auth", version: "0.0.1" }));
await writeFile(join(target, "packages", "auth", "src", "index.ts"), "export const login = () => null;\n");
execFileSync("git", ["init", "-q"], { cwd: target, stdio: "ignore" });
execFileSync("git", ["add", "-A"], { cwd: target, stdio: "ignore" });
execFileSync("git", ["-c", "user.email=s@e.com", "-c", "user.name=s", "commit", "-q", "-m", "init"], { cwd: target, stdio: "ignore" });

// One bubble pointed at packages/auth — a hook's file path must light it up. It is
// written in the pre-SQLite layout, which local mode takes over on the first attach.
await mkdir(join(target, ".shape"), { recursive: true });
await writeFile(
  join(target, ".shape", "graph.json"),
  JSON.stringify({
    rev: 1,
    nodes: [{ id: "auth", parentId: null, label: "Auth", summary: "logging in works", phase: "building", codeRefs: ["packages/auth"] }],
    edges: [],
  }),
);

// the harness command comes from the SHAPE_HOME config
await mkdir(join(fakeHome, ".shape"), { recursive: true });
await writeFile(
  join(fakeHome, ".shape", "config.json"),
  JSON.stringify({
    backend: "claude",
    backends: { claude: { command: [process.execPath, fakeClaude], permissionMode: "acceptEdits" } },
  }),
);

const frames = [];
let bridge = null;
let socket = null;

/** everything the fake claude was launched with, typed at, or signalled with */
function claudeFrames() {
  if (!existsSync(claudeLog)) return [];
  return readFileSync(claudeLog, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * One hook, exactly as Claude Code fires it: the link's hook script with the
 * payload on stdin and the agent's loopback link in its environment. This is
 * the whole event channel for a TUI harness — the bridge learns nothing about
 * the session any other way.
 */
async function runHook(payload) {
  const child = spawn(process.execPath, [LINK_HOOK], {
    env: { ...process.env, SHAPE_BRIDGE_URL: LINK_URL },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let hookErr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    hookErr += d;
  });
  child.stdin.end(JSON.stringify(payload));
  const exited = Promise.withResolvers();
  child.once("exit", (code) => exited.resolve(code));
  return { code: await exited.promise, stderr: hookErr };
}

try {
  bridge = spawn(process.execPath, ["src/index.ts", "--cwd", target, "--port", String(PORT), "--backend", "claude"], {
    cwd: process.cwd(),
    // SHAPE_HOME/HOME keep recents.json out of the real home dir; the fake
    // logs into the project it was started in, which is how the argv is read.
    // SHAPE_AUTO_MAP=0: the seeded project has code and no bubbles, and this
    // file drives its own turns through the hooks — a room mapping it by itself
    // would be a turn none of them asked for.
    env: { ...process.env, SHAPE_AUTO_MAP: "0", SHAPE_HOME: fakeHome, HOME: fakeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bridgeErr = "";
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (chunk) => {
    bridgeErr += chunk;
  });

  await waitFor("bridge listening", () => bridgeErr.includes("canvas at ws://"), 20_000);

  socket = new WebSocket(`ws://127.0.0.1:${String(PORT)}/ws`);
  socket.on("message", (data) => frames.push(JSON.parse(String(data))));
  await new Promise((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
  });

  const hello = await waitFor("hello", () => frames.find((f) => f.type === "hello"));
  const helloSession = hello.session.sessions.find((s) => s.worktree === mainWt);
  check(
    "hello names the claude backend, driven by hooks, in a terminal Shape owns",
    helloSession?.backend.id === "claude" && helloSession.backend.label === "Claude Code" &&
      helloSession.backend.capabilities.events === "hooks" && helloSession.backend.capabilities.terminal === "pane",
    JSON.stringify(helloSession?.backend ?? null),
  );
  check(
    "the seeded bubble loaded",
    hello.graphs[mainWt].nodes.length === 1 && hello.graphs[mainWt].nodes[0].id === "auth",
  );

  const started = await waitFor("the fake claude process", () => claudeFrames().find((f) => f.type === "__start"));
  check("the config's command array is what got spawned", started.cwd === mainWt, JSON.stringify(started));
  const argv = started.argv;
  check(
    "the spawned argv is the interactive contract, with the link wired in",
    flagAt(argv, "-p") === -1 && flagAt(argv, "--output-format") === -1 &&
      argv[flagAt(argv, "--allowedTools") + 1] === "mcp__shape__canvas" &&
      argv[flagAt(argv, "--permission-mode") + 1] === "acceptEdits" &&
      flagAt(argv, "--settings") !== -1,
    argv.join(" "),
  );
  const spawnedMcp = JSON.parse(argv[flagAt(argv, "--mcp-config") + 1]);
  check(
    "the spawned link points at THIS agent's socket",
    spawnedMcp.mcpServers.shape.env.SHAPE_BRIDGE_URL === LINK_URL,
    JSON.stringify(spawnedMcp.mcpServers.shape.env),
  );

  // --- the session announces itself through a hook --------------------------
  const sessionHook = await runHook({ hook_event_name: "SessionStart", session_id: "hooked-session-1", cwd: mainWt, source: "startup" });
  check("the SessionStart hook exits 0 and stays silent", sessionHook.code === 0 && sessionHook.stderr === "", `code=${sessionHook.code} ${sessionHook.stderr.slice(0, 120)}`);
  const learned = await waitFor("the session id on the wire", () =>
    frames
      .filter((f) => f.type === "hello" || f.type === "session")
      .map((f) => f.session.sessions.find((s) => s.worktree === mainWt)?.session)
      .find((s) => s !== undefined && s.sessionId === "hooked-session-1"),
  );
  check("a hook is how a TUI harness tells Shape which session it is on", learned.sessionId === "hooked-session-1", JSON.stringify(learned));

  // --- one utterance: pasted into the terminal ------------------------------
  frames.length = 0;
  socket.send(JSON.stringify({ type: "utterance", worktree: mainWt, referent: null, text: "read the auth package" }));
  const typed = await waitFor("the utterance pasted into the TUI", () =>
    claudeFrames().find((f) => f.type === "typed" && f.text.includes("read the auth package")),
  );
  check(
    "an utterance is typed at the harness, preamble and all — there is no other channel",
    typed.text.includes("<canvas-harness>") && typed.text.includes("read the auth package"),
    typed.text.slice(0, 60),
  );
  check(
    "and it is submitted: the paste is followed by a return",
    claudeFrames().some((f) => f.type === "key" && f.key === "enter"),
    JSON.stringify(claudeFrames().filter((f) => f.type === "key")),
  );
  const userLine = frames.find((f) => f.type === "transcript" && f.worktree === mainWt && f.role === "user");
  check(
    "the raw utterance is what the transcript shows the user saying",
    userLine?.text === "read the auth package",
    JSON.stringify(userLine ?? null),
  );

  // --- the turn, as the hooks report it -------------------------------------
  const promptAt = frames.length;
  await runHook({ hook_event_name: "UserPromptSubmit", session_id: "hooked-session-1", cwd: mainWt, prompt: "read the auth package" });
  await waitFor("streaming from the UserPromptSubmit hook", () =>
    frames.slice(promptAt).find((f) => f.type === "agent" && f.worktree === mainWt && f.state === "streaming"),
  );
  check("a prompt-submit hook is what puts the session in streaming", true);

  const toolAt = frames.length;
  await runHook({
    hook_event_name: "PreToolUse",
    session_id: "hooked-session-1",
    cwd: mainWt,
    tool_name: "Read",
    tool_input: { file_path: "packages/auth/src/index.ts" },
  });
  const toolLine = await waitFor("tool transcript", () =>
    frames.slice(toolAt).find((f) => f.type === "transcript" && f.worktree === mainWt && f.role === "tool" && f.text.startsWith("Read ")),
  );
  check("a tool hook becomes a transcript line named by its primary argument", toolLine.text === "Read packages/auth/src/index.ts", toolLine.text);
  const activity = await waitFor("activity", () =>
    frames.slice(toolAt).find((f) => f.type === "activity" && f.worktree === mainWt && f.nodeIds.length > 0),
  );
  check("the tool call's file_path lights up the bubble whose codeRefs cover it", activity.nodeIds.join(",") === "auth", JSON.stringify(activity));

  const transcriptPath = join(target, "claude-transcript.jsonl");
  await writeFile(
    transcriptPath,
    `${[
      { type: "user", message: { role: "user", content: "read the auth package" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Read how logging in checks passwords." }] } },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")}\n`,
  );
  const stopAt = frames.length;
  await runHook({ hook_event_name: "Stop", session_id: "hooked-session-1", cwd: mainWt, transcript_path: transcriptPath });
  await waitFor("the assistant's last message from the Stop hook", () =>
    frames.slice(stopAt).find((f) => f.type === "transcript" && f.role === "assistant" && f.text === "Read how logging in checks passwords."),
  );
  await waitFor("idle from the Stop hook", () =>
    frames.slice(stopAt).find((f) => f.type === "agent" && f.worktree === mainWt && f.state === "idle"),
  );
  const cleared = frames.slice(stopAt).filter((f) => f.type === "activity" && f.worktree === mainWt).at(-1);
  check(
    "the Stop hook ends the turn: the last message, no activity, idle again",
    cleared !== undefined && cleared.nodeIds.length === 0,
    JSON.stringify(cleared ?? null),
  );

  // --- going to the terminal, and aborting in it ----------------------------
  const focusAt = frames.length;
  socket.send(JSON.stringify({ type: "focus_terminal", worktree: mainWt }));
  const drawer = await waitFor("the terminal frame that opens the drawer", () =>
    frames.slice(focusAt).find((f) => f.type === "terminal" && f.worktree === mainWt),
  );
  check("a claude TUI in Shape's own pty is reached by opening the drawer", drawer.open === true, JSON.stringify(drawer));

  // a turn has to be running for there to be anything to interrupt, and only a
  // hook can say so about a TUI harness
  await runHook({ hook_event_name: "UserPromptSubmit", session_id: "hooked-session-1", cwd: mainWt, prompt: "keep going" });
  await waitFor("streaming again", () =>
    frames.filter((f) => f.type === "agent" && f.worktree === mainWt && f.state === "streaming").length >= 2,
  );
  socket.send(JSON.stringify({ type: "abort", worktree: mainWt }));
  await sleep(1500);
  const escaped = claudeFrames().find((f) => f.type === "key" && f.key === "escape");
  check(
    "aborting a TUI harness is the keystroke a person would press",
    escaped !== undefined,
    JSON.stringify(claudeFrames().filter((f) => f.type === "key" || f.type === "typed").map((f) => f.type === "key" ? f.key : "typed")),
  );
} catch (err) {
  check("bridge drives the fake claude end to end", false, String(err));
} finally {
  socket?.close();
  bridge?.kill("SIGKILL");
  await sleep(100);
}

console.log(results.join("\n"));
console.log(`\n${String(results.length - failed)}/${String(results.length)} checks passed`);
process.exit(failed === 0 ? 0 : 1);
