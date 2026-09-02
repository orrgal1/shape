/**
 * The events channel of last resort: one harness hook payload in, one agent
 * event out.
 *
 * A harness with no streaming API still calls hooks around every prompt, tool
 * and turn end (Claude Code's shape is the reference: `hook_event_name`,
 * `session_id`, `transcript_path`, `tool_name`, `tool_input`, `tool_response`,
 * `cwd`). This process reads one such payload on stdin, sends the equivalent
 * `agent_event` to the bridge, and gets out of the way.
 *
 * Launch line (see ./paths.ts): `node packages/link/src/hook.ts`, with
 * `SHAPE_BRIDGE_URL` when the bridge is not on the default port.
 *
 * Two hard rules, because this runs inside the user's agent loop:
 * - never block the harness — a whole run is capped at HOOK_BUDGET_MS;
 * - never fail the harness — the exit code is always 0, whatever went wrong.
 */

import { readFile } from "node:fs/promises";
import WebSocket from "ws";
import { BRIDGE_PORT, BRIDGE_WS_PATH } from "../../shared/src/index.ts";
import type { AgentEvent } from "../../shared/src/link.ts";

const BRIDGE_URL = process.env.SHAPE_BRIDGE_URL ?? `ws://127.0.0.1:${BRIDGE_PORT}${BRIDGE_WS_PATH}`;

/** the harness is waiting on us: the whole run, connect included, fits in this */
const HOOK_BUDGET_MS = 2000;

/** a tool argument longer than this is prose, not a path */
const MAX_PATH_LEN = 512;

/** the keys harnesses use for the one argument worth showing a human */
const SUMMARY_KEYS = ["file_path", "command", "pattern", "path", "url", "prompt"];

/** how much of a summary the side panel can use */
const MAX_SUMMARY_LEN = 200;

/**
 * Every field of a hook payload is outside data; the shape is only read through
 * `record()` + `typeof` checks below, never trusted.
 */
type Json = Record<string, unknown>;

/** JSON objects arrive as `unknown`; this is the one place that admits them */
function record(value: unknown): Json | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // checked immediately above: an object literal from JSON.parse is a Json
  return value as Json;
}

/**
 * Path-shaped by value, not by key name: harnesses invent tool argument names
 * freely, but a path still looks like a path. Prose, shell command lines
 * (whitespace) and URLs are not paths.
 */
function looksLikePath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PATH_LEN) return false;
  if (/\s/.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  return value.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(value);
}

function toolPaths(input: unknown): string[] {
  const fields = record(input);
  if (fields === null) return [];
  const paths: string[] = [];
  for (const value of Object.values(fields)) {
    if (typeof value === "string") {
      if (looksLikePath(value)) paths.push(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && looksLikePath(item)) paths.push(item);
    }
  }
  return paths;
}

function toolSummary(input: unknown): string {
  const fields = record(input);
  if (fields === null) return "";
  for (const key of SUMMARY_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) return value.slice(0, MAX_SUMMARY_LEN);
  }
  return "";
}

/** a failed tool is worth a transcript line; harnesses spell failure differently */
function isErrorResponse(response: unknown): boolean {
  if (typeof response === "string") return /^error\b/i.test(response.trim());
  const fields = record(response);
  if (fields === null) return false;
  if (fields.is_error === true || fields.isError === true || fields.success === false) return true;
  return typeof fields.error === "string" && fields.error.length > 0;
}

/** the text blocks of one transcript entry's content, concatenated */
function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    const fields = record(block);
    if (fields !== null && typeof fields.text === "string") text += fields.text;
  }
  return text.trim();
}

/**
 * The last thing the agent said, read from the harness's own transcript: on a
 * turn-end hook there is no message in the payload, only a path to the JSONL
 * log. Tool-only assistant entries carry no text and are skipped.
 */
async function lastAssistantText(transcriptPath: unknown): Promise<string> {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return "";
  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line === undefined || line.length === 0) continue;
    let entry: Json | null;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry === null) continue;
    const message = record(entry.message) ?? entry;
    if ((message.role ?? entry.type) !== "assistant") continue;
    const text = contentText(message.content);
    if (text.length > 0) return text;
  }
  return "";
}

/**
 * One payload maps to one event, except a turn end: "here is what you said",
 * "the turn is over" and "I am idle again" are three distinct facts the bridge
 * acts on differently (transcript line, activity clear, agent state).
 */
async function eventsFor(payload: Json): Promise<AgentEvent[]> {
  const name = typeof payload.tool_name === "string" ? payload.tool_name : "tool";
  switch (payload.hook_event_name) {
    case "UserPromptSubmit":
      return [{ kind: "state", state: "streaming" }];
    case "PreToolUse":
      return [
        {
          kind: "tool_start",
          name,
          paths: toolPaths(payload.tool_input),
          summary: toolSummary(payload.tool_input),
        },
      ];
    case "PostToolUse":
      return [{ kind: "tool_end", name, isError: isErrorResponse(payload.tool_response) }];
    case "Stop":
    case "SubagentStop": {
      const text = await lastAssistantText(payload.transcript_path);
      const events: AgentEvent[] = [];
      if (text.length > 0) events.push({ kind: "text", text });
      events.push({ kind: "turn_end" }, { kind: "state", state: "idle" });
      return events;
    }
    case "SessionStart":
      return [
        {
          kind: "session",
          sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
          model: null,
        },
      ];
    default:
      return [];
  }
}

async function send(events: AgentEvent[]): Promise<void> {
  if (events.length === 0) return;
  const socket = new WebSocket(BRIDGE_URL);
  const { promise, resolve } = Promise.withResolvers<void>();
  // a bridge that is not running is the normal case outside Shape: say nothing
  socket.on("error", () => resolve());
  socket.on("close", () => resolve());
  socket.on("open", () => {
    for (const event of events) socket.send(JSON.stringify({ type: "agent_event", event }));
    // close() after send() flushes the queued frames first
    socket.close();
  });
  await promise;
}

// the budget is wall-clock: a hung read, a hung connect and a hung send all
// end the same way, with the harness unblocked
const deadline = setTimeout(() => process.exit(0), HOOK_BUDGET_MS);
deadline.unref();

try {
  process.stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const payload = record(JSON.parse(raw));
  if (payload !== null) await send(await eventsFor(payload));
} catch {
  // a malformed payload is not the harness's problem
}
process.exit(0);
