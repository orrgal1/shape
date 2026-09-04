/**
 * Self-test for the omp extension: the real `omp-extension.ts` against a real
 * WebSocket server and a stub `pi`.
 *
 * omp itself cannot be scripted (an interactive TUI is the only thing that
 * loads an extension), so what is checked here is the whole contract Shape
 * depends on: the frames the extension sends for each omp event, and what it
 * does with each frame the bridge sends back. The stub `pi` is the documented
 * surface (`on`, `registerTool`, `sendUserMessage`, `zod`, `logger`) and a ctx
 * with the getters the extension reads.
 *
 * Run: pnpm --filter @shape/link run selftest:omp
 */

import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let checks = 0;

function eq(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label);
  checks += 1;
}

function truthy(value, label) {
  assert.ok(value, label);
  checks += 1;
}

const inbox = [];
let wake = null;

function push(frame) {
  inbox.push(frame);
  const resolve = wake;
  wake = null;
  if (resolve !== null) resolve();
}

/** the first queued frame matching `match`, removed from the queue */
async function take(match, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const index = inbox.findIndex(match);
    if (index >= 0) return inbox.splice(index, 1)[0];
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}; queue: ${JSON.stringify(inbox)}`);
    }
    await new Promise((resolve) => {
      wake = resolve;
      setTimeout(resolve, 20);
    });
  }
}

const isEvent = (kind) => (frame) => frame.type === "agent_event" && frame.event.kind === kind;

/** nothing arrived at all — used to prove a non-terminal agent_end is silent */
async function quiet(label, ms = 200) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  eq(inbox.length, 0, label);
}

// ---------------------------------------------------------------------------
// the stub pi
// ---------------------------------------------------------------------------

/** a zod-compatible builder that records the schema instead of compiling it */
function zNode(spec) {
  return {
    spec,
    optional: () => zNode({ ...spec, optional: true }),
    nullable: () => zNode({ ...spec, nullable: true }),
    describe: (text) => zNode({ ...spec, description: text }),
    min: (n) => zNode({ ...spec, min: n }),
    max: (n) => zNode({ ...spec, max: n }),
  };
}

const zod = {
  object: (shape) => zNode({ type: "object", shape }),
  array: (items) => zNode({ type: "array", items }),
  string: () => zNode({ type: "string" }),
  number: () => zNode({ type: "number" }),
  boolean: () => zNode({ type: "boolean" }),
  enum: (values) => zNode({ type: "enum", values }),
  unknown: () => zNode({ type: "unknown" }),
};

function makePi() {
  const handlers = new Map();
  const state = { tools: [], sent: [], logs: [], aborts: 0, timers: new Set() };
  const pi = {
    on(event, handler) {
      const list = handlers.get(event);
      if (list === undefined) handlers.set(event, [handler]);
      else list.push(handler);
    },
    registerTool(definition) {
      state.tools.push(definition);
    },
    sendUserMessage(content, options) {
      state.sent.push({ content, options });
    },
    logger: { info: (message) => state.logs.push(message) },
    zod,
  };
  const ctx = {
    cwd: "/tmp/shape-selftest",
    sessionManager: {
      getSessionId: () => "0199cafe-1234",
      getSessionFile: () => "/tmp/sessions/0199cafe-1234.jsonl",
    },
    models: { current: () => ({ provider: "anthropic", id: "claude-opus-5" }) },
    abort: () => {
      state.aborts += 1;
    },
    setInterval: (fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      state.timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => {
      clearInterval(timer);
      state.timers.delete(timer);
    },
  };
  const fire = async (event, payload = {}) => {
    let last;
    for (const handler of [...(handlers.get(event) ?? [])]) {
      const result = await handler(payload, ctx);
      if (result !== undefined) last = result;
    }
    return last;
  };
  return { pi, ctx, state, fire };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
const url = `ws://127.0.0.1:${server.address().port}/link`;

let client = null;
server.on("connection", (socket) => {
  client = socket;
  socket.on("message", (data) => push(JSON.parse(data.toString())));
});

const reply = (frame) => client.send(JSON.stringify(frame));

process.env.SHAPE_LINK = url;
const { default: extension } = await import("../src/omp-extension.ts");
const { pi, state, fire } = makePi();
extension(pi);

// --- the canvas tool, registered at load time (before any session) ---------
eq(state.tools.length, 1, "one tool registered");
const canvas = state.tools[0];
eq(canvas.name, "canvas", "tool name");
eq(canvas.loadMode, "essential", "the canvas tool is never unloaded");
truthy(canvas.description.includes("visual canvas"), "shared description used");

// --- CANVAS_TOOL_SCHEMA translated into pi.zod -----------------------------
const params = canvas.parameters.spec;
eq(params.type, "object", "parameters are an object schema");
eq(params.shape.ops.spec.type, "array", "ops is an array");
eq(params.shape.ops.spec.min, 1, "ops carries minItems");
eq(params.shape.ops.spec.optional, undefined, "ops is required");
eq(params.shape.note.spec.optional, true, "note is optional");
const op = params.shape.ops.spec.items.spec.shape;
eq(op.op.spec.type, "enum", "op is an enum");
truthy(op.op.spec.values.includes("upsert_node"), "op enum carries the ops");
truthy(op.node.spec.shape.phase.spec.values.includes("built"), "node phase enum");
eq(op.node.spec.shape.parentId.spec.nullable, true, "parentId is nullable");
eq(op.node.spec.shape.id.spec.optional, undefined, "node id is required");
eq(op.node.spec.shape.status.spec.optional, true, "node status is optional");
const next = params.shape.next.spec;
eq(next.optional, true, "next is optional");
eq(next.shape.choices.spec.max, 4, "choices carries maxItems");
eq(next.shape.question.spec.nullable, true, "question is nullable");
truthy(typeof next.description === "string", "next keeps its description");

// --- session_start: hello, then the session event -------------------------
await fire("session_start");
const hello = await take((f) => f.type === "hello", "hello");
eq(hello.cwd, "/tmp/shape-selftest", "hello cwd is ctx.cwd");
eq(hello.harness, "omp", "hello harness");
eq(hello.sessionId, "0199cafe-1234", "hello sessionId from sessionManager");
eq(hello.sessionFile, "/tmp/sessions/0199cafe-1234.jsonl", "hello sessionFile");
eq(hello.model, { provider: "anthropic", id: "claude-opus-5" }, "hello model from ctx.models");
eq(hello.capabilities, { steer: true, tool: true }, "hello capabilities");

const sessionFrame = await take(isEvent("session"), "session event");
eq(sessionFrame.cwd, "/tmp/shape-selftest", "session event cwd");
eq(sessionFrame.event.sessionId, "0199cafe-1234", "session event id");
eq(sessionFrame.event.sessionFile, "/tmp/sessions/0199cafe-1234.jsonl", "session event file");
eq(sessionFrame.event.model.id, "claude-opus-5", "session event model");

// --- a turn ---------------------------------------------------------------
await fire("agent_start");
eq((await take(isEvent("state"), "streaming")).event.state, "streaming", "agent_start streams");

await fire("message_start");
await fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "Hello " } });
await fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "canvas" } });
await fire("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
eq((await take(isEvent("text_delta"), "first delta")).event.delta, "Hello ", "first text delta");
eq((await take(isEvent("text_delta"), "second delta")).event.delta, "canvas", "second text delta");
await quiet("thinking deltas are not text");

// omp ends the user's own messages and its injected reminders through this same
// event (found against real omp 18.1.2: a delivered prompt came back as an
// assistant line, as did omp's own system reminder)
await fire("message_end", {
  message: { role: "user", content: [{ type: "text", text: "<canvas-harness> you are on a canvas" }] },
});
await quiet("a user message_end is not the agent talking");
await fire("message_end", { message: { content: "<system-reminder> task delegation enabled" } });
await quiet("a role-less custom message_end is not the agent talking either");

// ...and neither of them may eat the deltas of the message still in flight
await fire("message_end", { message: { role: "assistant", content: [] } });
eq((await take(isEvent("text"), "text from deltas")).event.text, "Hello canvas", "the deltas survived and flushed");

await fire("message_start");
await fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "partial" } });
await take(isEvent("text_delta"), "delta before the snapshot");
await fire("message_end", {
  message: { role: "assistant", content: [{ type: "text", text: "Hello again" }] },
});
eq((await take(isEvent("text"), "text")).event.text, "Hello again", "message_end sends the whole snapshot text");

await fire("tool_execution_start", {
  toolName: "read",
  args: { path: "packages/link/src/omp-extension.ts" },
});
const toolStart = await take(isEvent("tool_start"), "tool_start");
eq(toolStart.event.name, "read", "tool_start name");
eq(toolStart.event.paths, ["packages/link/src/omp-extension.ts"], "tool_start paths");
eq(toolStart.event.summary, "packages/link/src/omp-extension.ts", "tool_start summary");

await fire("tool_execution_end", { toolName: "read", isError: true });
const toolEnd = await take(isEvent("tool_end"), "tool_end");
eq(toolEnd.event, { kind: "tool_end", name: "read", isError: true }, "tool_end frame");

// compaction inside the turn ends in more streaming, not in idleness
await fire("auto_compaction_start");
eq((await take(isEvent("state"), "compacting")).event.state, "compacting", "compaction start");
await fire("auto_compaction_end");
eq((await take(isEvent("state"), "post-compaction")).event.state, "streaming", "mid-turn compaction end");

await fire("agent_end", { isTerminal: false });
await quiet("a non-terminal agent_end is not a turn end");

await fire("agent_end", { isTerminal: true });
truthy(await take(isEvent("turn_end"), "turn_end"), "terminal agent_end ends the turn");
eq((await take(isEvent("state"), "idle")).event.state, "idle", "terminal agent_end goes idle");

// compaction outside a turn ends idle
await fire("session.compacting");
eq((await take(isEvent("state"), "compacting")).event.state, "compacting", "manual compaction start");
await fire("session_compact");
eq((await take(isEvent("state"), "idle")).event.state, "idle", "idle compaction end");

// --- deliver --------------------------------------------------------------
reply({ type: "deliver", id: "d1", body: "make the header blue", mode: "steer" });
const steered = await take((f) => f.type === "delivered", "delivered (steer)");
eq(steered, { type: "delivered", cwd: "/tmp/shape-selftest", id: "d1", mode: "steer", queued: false }, "steer receipt");
eq(state.sent[0], { content: "make the header blue", options: { deliverAs: "steer" } }, "steer delivery");

reply({ type: "deliver", id: "d2", body: "start on the login screen", mode: "prompt" });
const prompted = await take((f) => f.type === "delivered", "delivered (prompt)");
eq(prompted.mode, "prompt", "prompt receipt mode");
eq(state.sent[1], { content: "start on the login screen", options: {} }, "prompt delivery");

// --- autonomous + tool_call ----------------------------------------------
eq(await fire("tool_call", { toolName: "bash" }), undefined, "tool_call is untouched by default");
reply({ type: "autonomous", on: true });
// a flag frame is answered by nothing; give the socket a moment to land it
await new Promise((resolve) => setTimeout(resolve, 100));
eq(await fire("tool_call", { toolName: "bash" }), {}, "autonomous allows the call");
reply({ type: "autonomous", on: false });
await new Promise((resolve) => setTimeout(resolve, 100));
eq(await fire("tool_call", { toolName: "bash" }), undefined, "autonomous off restores the gate");

// --- abort ----------------------------------------------------------------
reply({ type: "abort" });
await new Promise((resolve) => setTimeout(resolve, 100));
eq(state.aborts, 1, "abort calls ctx.abort()");

// --- the canvas round trip ------------------------------------------------
const call = canvas.execute("toolu_1", { ops: [{ op: "set_phase", id: "root", phase: "building" }] }, undefined, undefined, {
  cwd: "/tmp/shape-selftest",
});
const canvasCall = await take((f) => f.type === "canvas_call", "canvas_call");
eq(canvasCall.cwd, "/tmp/shape-selftest", "canvas_call cwd");
eq(canvasCall.id, "omp-toolu_1", "canvas_call id derives from the tool call id");
eq(canvasCall.args, { ops: [{ op: "set_phase", id: "root", phase: "building" }] }, "canvas_call args");
reply({ type: "canvas_result", id: canvasCall.id, text: "applied 1 op", isError: false });
eq(await call, { content: [{ type: "text", text: "applied 1 op" }], isError: false }, "canvas result returned");

// an aborted call answers the model instead of hanging on a result nobody sends
const controller = new AbortController();
const abortedCall = canvas.execute("toolu_2", { ops: [] }, controller.signal, undefined, { cwd: "/tmp/shape-selftest" });
await take((f) => f.type === "canvas_call", "second canvas_call");
controller.abort();
eq(await abortedCall, { content: [{ type: "text", text: "canvas call aborted" }], isError: true }, "abort ends the call");

// --- reconnect: a bridge restart re-greets on the backoff tick ------------
client.close();
const rehello = await take((f) => f.type === "hello", "hello after reconnect");
eq(rehello.sessionId, "0199cafe-1234", "the reconnect re-sends hello");
truthy(await take(isEvent("session"), "session after reconnect"), "and the session event with it");

// --- shutdown -------------------------------------------------------------
await fire("session_shutdown");
const bye = await take((f) => f.type === "bye", "bye");
eq(bye, { type: "bye", cwd: "/tmp/shape-selftest", reason: "session shutdown" }, "bye frame");
eq(state.timers.size, 0, "the reconnect timer is cleared on shutdown");
eq(await canvas.execute("toolu_3", { ops: [] }, undefined, undefined, { cwd: "/tmp/shape-selftest" }), {
  content: [{ type: "text", text: "Shape server unreachable" }],
  isError: true,
}, "a closed link answers the model");

// --- no SHAPE_LINK: says so once, changes nothing else --------------------
delete process.env.SHAPE_LINK;
const { default: unlinked } = await import("../src/omp-extension.ts?no-link");
const bare = makePi();
unlinked(bare.pi);
await bare.fire("session_start");
eq(bare.state.logs, ["[shape] SHAPE_LINK is not set; the canvas link stays closed"], "unlinked launch logs once");
await bare.fire("agent_start");
eq(bare.state.logs.length, 1, "and stays quiet afterwards");
eq(bare.state.tools.length, 1, "the canvas tool is still registered");

for (const timer of state.timers) clearInterval(timer);
for (const timer of bare.state.timers) clearInterval(timer);
server.close();
client?.close();

console.log(`omp extension self-test: ${checks} checks passed`);
