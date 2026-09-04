#!/usr/bin/env node
/**
 * Interactive stand-in for the `claude` TUI in bridge smoke tests: a long-lived
 * process that sits in a terminal, reads what is typed at it, and says nothing
 * anybody listens to. Plain Node, no deps, no model, no network.
 *
 * Shape drives the real Claude Code the same way a person does — it launches it
 * in a terminal (a herdr tab, or a pty Shape owns) and pastes into it — and
 * hears about the session through hooks, never through this process's stdout.
 * So that is all this fake is: a launch to assert the argv of, a paste to
 * assert the text of, and an abort to assert the keystroke of.
 *
 * Everything it sees is appended to FAKE_CLAUDE_LOG (default
 * <cwd>/fake-claude.log), one JSON object per line:
 *   { "type": "__start", pid, cwd, argv }   at startup
 *   { "type": "typed", text }               a bracketed paste, markers stripped
 *   { "type": "key", key: "escape" | "enter" | "ctrl-c" }
 *   { "type": "__exit", pid, reason }       on SIGTERM/SIGINT
 *
 * Environment:
 *   FAKE_CLAUDE_LOG       where the log goes; default <cwd>/fake-claude.log
 *   FAKE_CLAUDE_SESSION   the session id it prints in its banner
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

const LOG = process.env.FAKE_CLAUDE_LOG ?? join(process.cwd(), "fake-claude.log");
const SESSION = process.env.FAKE_CLAUDE_SESSION ?? "fake-session-0001";

function record(entry) {
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

record({ type: "__start", pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2) });
// a banner, because a terminal that prints nothing looks broken to a human
// watching it; nothing reads this
process.stdout.write(`fake-claude ${SESSION} ready\n`);

/**
 * A pasted utterance arrives bracketed (`ESC[200~ … ESC[201~`) and is submitted
 * with a carriage return; anything else typed is a keystroke. The buffer is
 * kept across chunks because a paste is not guaranteed to arrive whole.
 */
let buf = "";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

function drain() {
  for (;;) {
    const start = buf.indexOf(PASTE_START);
    if (start >= 0) {
      const end = buf.indexOf(PASTE_END, start + PASTE_START.length);
      // an unfinished paste waits for the rest of it
      if (end < 0) return;
      record({ type: "typed", text: buf.slice(start + PASTE_START.length, end) });
      buf = buf.slice(end + PASTE_END.length);
      continue;
    }
    const key = buf.indexOf("\u001b");
    if (key >= 0) {
      // an ESC on its own is how a turn is interrupted from a keyboard
      record({ type: "key", key: "escape" });
      buf = buf.slice(key + 1);
      continue;
    }
    if (buf.includes("\u0003")) {
      record({ type: "key", key: "ctrl-c" });
      buf = buf.replaceAll("\u0003", "");
      continue;
    }
    const nl = buf.search(/[\r\n]/);
    if (nl < 0) return;
    record({ type: "key", key: "enter" });
    buf = buf.slice(nl + 1);
  }
}

// A TUI reads keys, not lines: without raw mode the terminal's line discipline
// would hold a bare ESC (which is how a turn is interrupted) until the next
// newline, and the real thing puts its terminal in raw mode for the same reason.
process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  drain();
});
// stdin closing is not a reason to leave: a TUI stays up until it is told to go
process.stdin.on("end", () => {});
process.stdin.resume?.();

const bye = (reason) => {
  record({ type: "__exit", pid: process.pid, reason });
  process.exit(0);
};
process.on("SIGTERM", () => bye("SIGTERM"));
process.on("SIGINT", () => bye("SIGINT"));
// nothing else keeps this process alive: it is a terminal application waiting
setInterval(() => {}, 1 << 30);
