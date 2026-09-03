#!/usr/bin/env node
/**
 * Claude Code adapter smoke test. Three layers, no network and no model:
 *
 *  1. the adapter in-process: mode defaults, capabilities, and the exact argv
 *     each mode builds (including the inline link MCP config and hook settings)
 *  2. PtyManager.attach: the terminal pane wired to a harness TUI instead of a
 *     shell, driven through a stub TerminalSource
 *  3. the real bridge on port 4403 driving scripts/fake-claude.mjs in headless
 *     mode, asserted over the WebSocket wire
 *
 * Usage (from packages/bridge): node scripts/smoke-claude.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const PORT = Number(process.env.SMOKE_CLAUDE_PORT ?? 4403);
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
const BRIDGE_URL = `ws://127.0.0.1:${String(PORT)}/link`;

// ---------------------------------------------------------------------------
// 1. the adapter in-process: modes, capabilities, argv
// ---------------------------------------------------------------------------

const { ClaudeBackend } = await import(new URL("../src/agent/backend/claude.ts", import.meta.url));

{
  const tui = new ClaudeBackend({ command: ["claude"] });
  check(
    "tui is the default mode and reports the TUI capability set",
    tui.capabilities.terminal === "tui" && tui.capabilities.events === "hooks" &&
      tui.capabilities.steerMidTurn === false && tui.capabilities.resume === true &&
      tui.capabilities.hostTool === true,
    JSON.stringify(tui.capabilities),
  );
  check("id/label are the wire identity of the harness", tui.id === "claude" && tui.label === "Claude Code");
  check("a TUI-mode adapter has no terminal source before start", tui.terminal() === null);

  const headless = new ClaudeBackend({ command: ["claude"], mode: "headless" });
  check(
    "headless reports native events, a shell pane, and mid-turn steering",
    headless.capabilities.terminal === "shell" && headless.capabilities.events === "native" &&
      headless.capabilities.steerMidTurn === true,
    JSON.stringify(headless.capabilities),
  );

  let threw = "";
  try {
    new ClaudeBackend({ command: ["claude"], mode: "interactive" });
  } catch (err) {
    threw = String(err.message ?? err);
  }
  check("an unknown mode is a startup error naming the two modes", threw.includes('"headless" or "tui"'), threw);
}

{
  const headless = new ClaudeBackend({ command: ["claude"], mode: "headless" });
  const argv = headless.argv({ bridgeUrl: BRIDGE_URL });
  const wanted = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  check(
    "headless argv opens with the stream-json contract",
    argv.slice(0, wanted.length).join(" ") === wanted.join(" "),
    argv.join(" "),
  );
  check(
    "headless argv allows exactly the link's canvas tool and accepts edits",
    argv[flagAt(argv, "--allowedTools") + 1] === "mcp__shape__canvas" &&
      argv[flagAt(argv, "--permission-mode") + 1] === "acceptEdits",
    argv.join(" "),
  );
  check("headless argv carries no --settings (hooks are the TUI's channel)", flagAt(argv, "--settings") === -1);
  check("headless argv has no --resume when nothing is being adopted", flagAt(argv, "--resume") === -1);

  const mcp = JSON.parse(argv[flagAt(argv, "--mcp-config") + 1]);
  check(
    "the inline --mcp-config launches the link's MCP server at this bridge",
    mcp.mcpServers.shape.args[0] === LINK_MCP && mcp.mcpServers.shape.env.SHAPE_BRIDGE_URL === BRIDGE_URL &&
      mcp.mcpServers.shape.command.length > 0,
    JSON.stringify(mcp),
  );

  const resumed = headless.argv({ bridgeUrl: BRIDGE_URL, resumeSessionId: "sess-42" });
  check("an adopted session id becomes --resume", resumed[flagAt(resumed, "--resume") + 1] === "sess-42", resumed.join(" "));
}

{
  const tui = new ClaudeBackend({
    command: ["claude", "--model", "opus"],
    args: ["--add-dir", "/tmp"],
    permissionMode: "bypassPermissions",
  });
  const argv = tui.argv({ bridgeUrl: BRIDGE_URL, resumeSessionId: "sess-7" });
  check(
    "tui argv keeps the configured command's own flags and appends extra args last",
    argv[0] === "--model" && argv[1] === "opus" && argv.slice(-2).join(" ") === "--add-dir /tmp",
    argv.join(" "),
  );
  check(
    "tui argv is interactive: no -p, no stream-json, no --permission-mode",
    flagAt(argv, "-p") === -1 && flagAt(argv, "--output-format") === -1 && flagAt(argv, "--permission-mode") === -1,
    argv.join(" "),
  );
  check("tui argv resumes the adopted session", argv[flagAt(argv, "--resume") + 1] === "sess-7");

  const settings = JSON.parse(argv[flagAt(argv, "--settings") + 1]);
  const events = Object.keys(settings.hooks).sort().join(",");
  check(
    "tui --settings wires every hook the link maps to an agent_event",
    events === "PostToolUse,PreToolUse,SessionStart,Stop,UserPromptSubmit",
    events,
  );
  const hook = settings.hooks.PreToolUse[0].hooks[0];
  check(
    "each hook runs the link's hook script with this bridge's url in its env",
    hook.type === "command" && hook.command.includes(LINK_HOOK) &&
      hook.command.startsWith(`SHAPE_BRIDGE_URL='${BRIDGE_URL}'`),
    hook.command,
  );
  check(
    "tool hooks match every tool; session hooks take no matcher",
    settings.hooks.PreToolUse[0].matcher === "*" && settings.hooks.Stop[0].matcher === undefined,
    JSON.stringify(settings.hooks.Stop),
  );
}

// ---------------------------------------------------------------------------
// 2. PtyManager.attach: the pane on a harness TUI
// ---------------------------------------------------------------------------

{
  const { PtyManager } = await import(new URL("../src/agent/pty.ts", import.meta.url));
  const sent = [];
  const pty = new PtyManager({ cwd: process.cwd(), broadcast: (msg) => sent.push(msg) });

  const source = {
    written: [],
    sizes: [],
    killed: false,
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

  pty.handle({ type: "pty_open", cols: 100, rows: 40 });
  check(
    "pty_open joins the running TUI at the browser's size instead of spawning a shell",
    source.sizes.join(",") === "100x40" && sent.at(-1).open === true,
    JSON.stringify(source.sizes),
  );

  pty.handle({ type: "pty_input", data: "hello" });
  pty.handle({ type: "pty_resize", cols: 90, rows: 30 });
  pty.handle({ type: "pty_close" });
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
// 3. the real bridge driving the fake claude in headless mode
// ---------------------------------------------------------------------------

const target = await mkdtemp(join(tmpdir(), "vh-claude-"));
const fakeHome = await mkdtemp(join(tmpdir(), "vh-claude-home-"));
const fakeClaude = resolve(process.cwd(), "scripts", "fake-claude.mjs");
const claudeLog = join(target, "fake-claude.log");

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

// one bubble pointed at packages/auth — the fake's Read call must light it up
await mkdir(join(target, ".shape"), { recursive: true });
await writeFile(
  join(target, ".shape", "graph.json"),
  JSON.stringify({
    rev: 1,
    nodes: [{ id: "auth", parentId: null, label: "Auth", summary: "logging in works", phase: "building", codeRefs: ["packages/auth"] }],
    edges: [],
  }),
);

// the harness command comes from the SHAPE_HOME config, mode included
await mkdir(join(fakeHome, ".shape"), { recursive: true });
await writeFile(
  join(fakeHome, ".shape", "config.json"),
  JSON.stringify({
    backend: "claude",
    backends: { claude: { command: [process.execPath, fakeClaude], mode: "headless", permissionMode: "acceptEdits" } },
  }),
);

const frames = [];
let bridge = null;
let socket = null;

/** frames the fake claude received, in order */
function claudeFrames() {
  if (!existsSync(claudeLog)) return [];
  return readFileSync(claudeLog, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

try {
  bridge = spawn(process.execPath, ["src/index.ts", "--cwd", target, "--port", String(PORT), "--backend", "claude"], {
    cwd: process.cwd(),
    // the held turn keeps the session streaming long enough to test the steer
    // branch; SHAPE_HOME/HOME keep recents.json out of the real home dir
    env: { ...process.env, FAKE_CLAUDE_TURN_HOLD_MS: "1200", SHAPE_HOME: fakeHome, HOME: fakeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bridgeErr = "";
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (chunk) => {
    bridgeErr += chunk;
  });

  await waitFor("bridge port", () => bridgeErr.includes("listening") || bridgeErr.includes(String(PORT)), 10000).catch(() => {});
  await sleep(400);

  socket = new WebSocket(`ws://127.0.0.1:${String(PORT)}/ws`);
  socket.on("message", (data) => frames.push(JSON.parse(String(data))));
  await new Promise((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
  });

  const hello = await waitFor("hello", () => frames.find((f) => f.type === "hello"));
  check(
    "hello names the claude backend and its headless capabilities",
    hello.session.backend.id === "claude" && hello.session.backend.label === "Claude Code" &&
      hello.session.backend.capabilities.events === "native" && hello.session.backend.capabilities.terminal === "shell",
    JSON.stringify(hello.session.backend),
  );
  check(
    "system.init reaches the wire as the session's id and model",
    hello.session.sessionId === "fake-session-0001" && hello.session.model?.id === "claude-fake-5" &&
      hello.session.model?.provider === "anthropic",
    JSON.stringify({ sessionId: hello.session.sessionId, model: hello.session.model }),
  );
  check("the seeded bubble loaded", hello.graph.nodes.length === 1 && hello.graph.nodes[0].id === "auth");

  const started = claudeFrames().find((f) => f.type === "__start");
  check("the config's command array is what got spawned", started !== undefined, JSON.stringify(started ?? null));
  const argv = started?.argv ?? [];
  check(
    "the spawned argv is the headless stream-json contract with the link wired in",
    argv.includes("-p") && argv[argv.indexOf("--output-format") + 1] === "stream-json" &&
      argv[argv.indexOf("--allowedTools") + 1] === "mcp__shape__canvas" &&
      argv[argv.indexOf("--permission-mode") + 1] === "acceptEdits",
    argv.join(" "),
  );
  const spawnedMcp = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]);
  check(
    "the spawned link points at THIS bridge's socket",
    spawnedMcp.mcpServers.shape.env.SHAPE_BRIDGE_URL === BRIDGE_URL,
    JSON.stringify(spawnedMcp.mcpServers.shape.env),
  );

  // --- one utterance: transcript, activity, turn end ------------------------
  frames.length = 0;
  socket.send(JSON.stringify({ type: "utterance", referent: null, text: "read the auth package" }));

  await waitFor("streaming", () => frames.find((f) => f.type === "agent" && f.state === "streaming"));
  check("an utterance puts the session in streaming", true);

  const assistant = await waitFor("assistant transcript", () =>
    frames.find((f) => f.type === "transcript" && f.role === "assistant"),
  );
  check(
    "assistant text blocks are coalesced into one transcript line",
    assistant.text.startsWith("ack:") && assistant.text.length > "ack:".length,
    assistant.text.slice(0, 60),
  );
  const userLine = frames.find((f) => f.type === "transcript" && f.role === "user");
  check(
    "the raw utterance is what the transcript shows the user saying",
    userLine?.text === "read the auth package",
    JSON.stringify(userLine ?? null),
  );
  check(
    "the first prompt of a session carries the canvas preamble",
    assistant.text.includes("<canvas-harness>"),
    assistant.text.slice(0, 60),
  );
  const toolLine = await waitFor("tool transcript", () =>
    frames.find((f) => f.type === "transcript" && f.role === "tool" && f.text.startsWith("Read ")),
  );
  check("a tool_use becomes a transcript line named by its primary argument", toolLine.text === "Read packages/auth/src/index.ts", toolLine.text);

  const activity = await waitFor("activity", () => frames.find((f) => f.type === "activity" && f.nodeIds.length > 0));
  check("the tool call's file_path lights up the bubble whose codeRefs cover it", activity.nodeIds.join(",") === "auth", JSON.stringify(activity));

  const prompt = claudeFrames().find((f) => f.type === "user");
  check(
    "the utterance was written as a stream-json user message, not steered",
    prompt !== undefined && typeof prompt.message.content === "string" &&
      prompt.message.content.includes("read the auth package") && prompt.priority === undefined,
    JSON.stringify(prompt ?? null).slice(0, 160),
  );

  // --- steering a held turn -------------------------------------------------
  socket.send(JSON.stringify({ type: "utterance", referent: null, text: "also check the db package" }));
  const steered = await waitFor("steered user frame", () =>
    claudeFrames().find((f) => f.type === "user" && f.priority === "now"),
  );
  check(
    "a second utterance mid-turn is injected with priority now",
    steered.message.content.includes("also check the db package"),
    JSON.stringify(steered).slice(0, 160),
  );

  // both turns must land before the last activity frame means anything: the
  // steered turn re-lights the same bubble after the first turn cleared it
  await waitFor("both turns idle", () => frames.filter((f) => f.type === "agent" && f.state === "idle").length >= 2, 15000);
  const cleared = frames.filter((f) => f.type === "activity").at(-1);
  check("the turn ending clears activity", cleared.nodeIds.length === 0, JSON.stringify(cleared));

  // --- abort ---------------------------------------------------------------
  socket.send(JSON.stringify({ type: "abort" }));
  const interrupt = await waitFor("interrupt", () => claudeFrames().find((f) => f.type === "control_request"));
  check(
    "abort sends an interrupt control_request with a request id",
    interrupt.request.subtype === "interrupt" && typeof interrupt.request_id === "string" && interrupt.request_id.length > 0,
    JSON.stringify(interrupt),
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
