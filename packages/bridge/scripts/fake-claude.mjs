#!/usr/bin/env node
/**
 * Protocol stub standing in for
 * `claude -p --input-format stream-json --output-format stream-json` in bridge
 * smoke tests: same stream-json frames, no model, no network, no clock.
 *
 * Every frame it receives is appended to FAKE_CLAUDE_LOG (default
 * <cwd>/fake-claude.log), starting with a `__start` record carrying the argv it
 * was launched with — that is how the smoke asserts the adapter's command line.
 *
 * One user message produces one turn:
 *   system.init -> assistant(text + tool_use Read) -> user(tool_result) -> result
 *
 * Unlike the real CLI it also emits `system.init` once at startup, so a bridge
 * that asks for `state()` right after `start()` already knows the session.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

const LOG = process.env.FAKE_CLAUDE_LOG ?? join(process.cwd(), "fake-claude.log");
/** the file the fake's Read tool call claims to touch — an activity probe */
const FILE = process.env.FAKE_CLAUDE_FILE ?? "packages/auth/src/index.ts";
const SESSION = process.env.FAKE_CLAUDE_SESSION ?? "fake-session-0001";
const MODEL = process.env.FAKE_CLAUDE_MODEL ?? "claude-fake-5";
/** ms to hold a turn open before `result` — lets a test steer mid-turn */
const TURN_HOLD_MS = Number(process.env.FAKE_CLAUDE_TURN_HOLD_MS ?? 0);

function out(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function record(frame) {
  appendFileSync(LOG, `${JSON.stringify(frame)}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let turns = 0;
/** turns are serialized, exactly like the real CLI's sequential prompt queue */
let queue = Promise.resolve();

function init() {
  out({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: SESSION,
    model: MODEL,
    tools: ["Read", "Edit", "Bash"],
    mcp_servers: [{ name: "shape", status: "connected" }],
    permissionMode: "acceptEdits",
    messaging_socket_path: `/tmp/cc-socks/${process.pid}.sock`,
  });
}

async function runTurn(text) {
  turns += 1;
  const id = `toolu_fake_${turns}`;
  init();
  out({
    type: "assistant",
    message: {
      id: `msg_fake_${turns}`,
      role: "assistant",
      model: MODEL,
      content: [
        { type: "text", text: `ack: ${text.slice(0, 200)}` },
        { type: "tool_use", id, name: "Read", input: { file_path: FILE } },
      ],
    },
    session_id: SESSION,
  });
  out({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "1 line", is_error: false }] },
    session_id: SESSION,
  });
  if (TURN_HOLD_MS > 0) await sleep(TURN_HOLD_MS);
  out({ type: "result", subtype: "success", result: `ack: ${text.slice(0, 200)}`, session_id: SESSION, num_turns: turns });
}

function handle(frame) {
  record(frame);
  if (frame.type === "control_request") {
    // the real CLI answers every control_request; interrupt also ends the turn
    out({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: {} } });
    return;
  }
  if (frame.type !== "user") return;
  const content = frame.message?.content;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  queue = queue.then(() => runTurn(text));
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line.length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      record({ type: "__unparseable", line });
      continue;
    }
    handle(frame);
  }
});
process.stdin.on("end", () => {
  queue.then(() => process.exit(0));
});

record({ type: "__start", pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2) });
init();
