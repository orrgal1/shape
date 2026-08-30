#!/usr/bin/env node
/**
 * Protocol stub standing in for `omp --mode rpc` in bridge smoke tests.
 * Plain Node, no deps. Speaks the subset of rpc.md the bridge uses.
 *
 * On `prompt`: agent_start -> assistant text -> canvas host_tool_call
 * (two nodes + one edge) -> agent_end{isTerminal:true}.
 * On `prompt` matching /survey/i: the onboarding survey turn.
 * On `steer`: echoes the received message as assistant text.
 *
 * Every received frame is appended as JSONL to $FAKE_OMP_LOG, defaulting to
 * <cwd>/fake-omp.log — the cwd is the target project, so each project a test
 * switches between gets its own log. Lifecycle markers `__start`/`__exit` carry
 * the pid so a test can prove which child served a turn and that it exited.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

const LOG = process.env.FAKE_OMP_LOG ?? join(process.cwd(), "fake-omp.log");

function out(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function record(frame) {
  appendFileSync(LOG, `${JSON.stringify(frame)}\n`);
}

const state = {
  model: { provider: "fake", id: "fake-1" },
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  sessionFile: "/tmp/fake-omp/session.jsonl",
  sessionId: "fake-session-1",
  sessionName: "fake session",
  fastModeEnabled: false,
  tokensPerSecond: null,
  fastModeActive: false,
  autoCompactionEnabled: true,
  messageCount: 0,
  queuedMessageCount: 0,
  todoPhases: [],
  contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 },
};

let hostToolNames = [];
let hostSeq = 0;
const pendingHostCalls = new Map();

const CANVAS_OPS = [
  {
    op: "upsert_node",
    node: {
      id: "auth-service",
      parentId: null,
      label: "Auth Service",
      summary: "Issues sessions and validates credentials for every caller.",
      phase: "component",
      codeRefs: ["packages/auth"],
    },
  },
  {
    op: "upsert_node",
    node: {
      id: "user-db",
      parentId: null,
      label: "User DB",
      summary: "Stores user records and password hashes durably.",
      phase: "concept",
    },
  },
  {
    op: "upsert_edge",
    edge: {
      id: "auth-service--user-db",
      source: "auth-service",
      target: "user-db",
      kind: "dataflow",
      label: "credentials",
    },
  },
];

/** deliberately malformed batch: unknown parent, bad phase on a live node, unknown op */
const BAD_OPS = [
  {
    op: "upsert_node",
    node: {
      id: "orphan",
      parentId: "no-such-parent",
      label: "Orphan",
      summary: "A bubble whose parent does not exist.",
      phase: "idea",
    },
  },
  { op: "set_phase", id: "auth-service", phase: "bogus" },
  { op: "explode" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** ms to hold a turn open before turn_end — lets a test steer mid-stream */
const TURN_HOLD_MS = Number(process.env.FAKE_OMP_TURN_HOLD_MS ?? 0);
/** turns run off the command queue, exactly like omp's immediate prompt ack */
let turns = Promise.resolve();

/** canvas call for the onboarding survey turn: one legal enrich, one unpointable claim.
 *  Ids/paths match the pnpm workspace scripts/smoke.mjs seeds (@t/auth -> t-auth). */
const SURVEY_OPS = [
  {
    op: "upsert_node",
    node: {
      id: "t-auth",
      parentId: null,
      label: "auth",
      summary: "Validates credentials and hands the rest of the workspace a session.",
      status: "reading how the other parts use it",
      phase: "built",
      codeRefs: ["packages/auth"],
    },
  },
  {
    op: "upsert_node",
    node: {
      id: "ghost",
      parentId: null,
      label: "ghost layer",
      summary: "A layer I inferred from the README rather than the code.",
      phase: "built",
      codeRefs: ["packages/nope"],
    },
  },
];

async function callCanvas(args) {
  const id = `host_${++hostSeq}`;
  const { promise, resolve } = Promise.withResolvers();
  pendingHostCalls.set(id, resolve);
  out({ type: "host_tool_call", id, toolCallId: `toolu_${hostSeq}`, toolName: "canvas", arguments: args });
  return promise;
}

async function runSurveyTurn() {
  state.isStreaming = true;
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "surveying the workspace packages." },
    message: { role: "assistant", content: [] },
  });
  out({ type: "message_end", message: { role: "assistant", content: [] } });
  await callCanvas({ ops: SURVEY_OPS, note: "survey pass" });
  out({ type: "turn_end" });
  state.isStreaming = false;
  out({ type: "agent_end", messages: [], isTerminal: true });
}

/** issues one all-rejected canvas batch — exercises structured repair receipts */
async function runBadOpTurn() {
  state.isStreaming = true;
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "probing receipts." },
    message: { role: "assistant", content: [] },
  });
  out({ type: "message_end", message: { role: "assistant", content: [] } });
  await callCanvas({ ops: BAD_OPS, note: "malformed batch" });
  out({ type: "turn_end" });
  state.isStreaming = false;
  out({ type: "agent_end", messages: [], isTerminal: true });
}

async function runTurn(text) {
  state.isStreaming = true;
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: `ack: ${text.slice(0, 40)}` },
    message: { role: "assistant", content: [] },
  });
  out({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: " — sketching the canvas." },
    message: { role: "assistant", content: [] },
  });
  out({ type: "message_end", message: { role: "assistant", content: [] } });

  await callCanvas({ ops: CANVAS_OPS, note: "initial decomposition" });

  out({
    type: "tool_execution_start",
    toolCallId: `toolu_w${hostSeq}`,
    toolName: "write",
    startedAt: new Date().toISOString(),
    args: { path: "packages/auth/src/index.ts" },
  });
  out({ type: "tool_execution_end", toolCallId: `toolu_w${hostSeq}`, toolName: "write", isError: false });

  if (TURN_HOLD_MS > 0) await sleep(TURN_HOLD_MS);

  out({ type: "turn_end" });
  state.isStreaming = false;
  state.messageCount += 1;
  out({ type: "agent_end", messages: [], isTerminal: true });
}

async function handle(cmd) {
  record(cmd);
  const id = cmd.id;
  switch (cmd.type) {
    case "get_state":
      out({ id, type: "response", command: "get_state", success: true, data: { ...state } });
      return;
    case "set_host_tools":
      hostToolNames = (cmd.tools ?? []).map((t) => t.name);
      out({
        id,
        type: "response",
        command: "set_host_tools",
        success: true,
        data: { toolNames: hostToolNames },
      });
      return;
    case "prompt":
      state.isStreaming = true;
      out({ id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
      turns = turns.then(async () => {
        await sleep(5);
        const message = String(cmd.message ?? "");
        if (/survey/i.test(message)) await runSurveyTurn();
        else if (/bad-op/i.test(message)) await runBadOpTurn();
        else await runTurn(message);
      });
      return;
    case "steer": {
      // mid-turn steering: acknowledge inside the running turn, no new lifecycle
      out({ id, type: "response", command: "steer", success: true });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      out({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: `steered: ${String(cmd.message ?? "")}` },
        message: { role: "assistant", content: [] },
      });
      out({ type: "message_end", message: { role: "assistant", content: [] } });
      return;
    }
    case "abort":
      state.isStreaming = false;
      out({ id, type: "response", command: "abort", success: true });
      return;
    case "host_tool_result": {
      const resolve = pendingHostCalls.get(cmd.id);
      if (resolve !== undefined) {
        pendingHostCalls.delete(cmd.id);
        resolve(cmd);
      }
      return;
    }
    case "host_tool_update":
      return;
    default:
      out({
        id: undefined,
        type: "response",
        command: "unknown",
        success: false,
        error: `unknown command ${String(cmd.type)}`,
      });
      return;
  }
}

let buf = "";
let queue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line.length > 0) {
      let cmd;
      try {
        cmd = JSON.parse(line);
      } catch {
        out({ type: "response", command: "parse", success: false, error: "invalid JSON" });
        cmd = null;
      }
      // Host-tool traffic must bypass the command queue: a turn awaiting its
      // host_tool_result is itself sitting in that queue.
      if (cmd !== null && (cmd.type === "host_tool_result" || cmd.type === "host_tool_update")) {
        void handle(cmd);
      } else if (cmd !== null) {
        queue = queue.then(() => handle(cmd));
      }
    }
    nl = buf.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  queue.then(() => {
    record({ type: "__exit", pid: process.pid });
    process.exit(0);
  });
});

record({ type: "__start", pid: process.pid, cwd: process.cwd() });

out({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
});
out({ type: "available_commands_update", commands: [] });
