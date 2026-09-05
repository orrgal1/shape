#!/usr/bin/env node
/**
 * Protocol stub standing in for `omp` + the Shape omp extension
 * (`packages/link/src/omp-extension.ts`) in bridge smoke tests: a harness that
 * lives on the LOOPBACK LINK, not on stdio. Plain Node, no deps — the global
 * `WebSocket` is enough.
 *
 * From the agent's point of view this is a real session: it connects to
 * `$SHAPE_LINK`, announces itself with `hello`, and then runs one turn for
 * every prompt TYPED into its pane. Shape reads sessions, it never sends them
 * work, so nothing on the link starts a turn here; a turn produces the frames
 * a real one does (state, text deltas, a whole text, a tool pair, a
 * `canvas_call`, `turn_end`), and `bye` goes out on SIGTERM or when the link
 * closes.
 *
 * Environment:
 *   SHAPE_LINK              ws url of the agent's loopback link (required)
 *   SHAPE_WORKTREE          the `cwd` every frame carries; defaults to process.cwd()
 *   FAKE_OMP_LOG            JSONL log path; defaults to <cwd>/fake-omp.log
 *   FAKE_OMP_TURN_HOLD_MS   ms to hold a turn open before `turn_end` (default 0),
 *                           so a test can watch a session while it is working
 *   FAKE_OMP_SESSION_DIR    where the fake session file is claimed to live
 *                           (default /tmp/fake-omp-tui)
 * Arguments:
 *   --resume <id>           echoed as `hello.sessionId` instead of a fresh one
 *
 * stdin (one JSON object per line) — a herdr pane types into a TUI, it does not
 * speak the link:
 *   { "type": "typed", "text": "…" }   the user typed a prompt and hit enter
 * stdout (one JSON object per line) — what a supervisor (scripts/fake-herdr.mjs)
 * can see of a TUI without scraping a terminal:
 *   { "type": "ready", "pid", "sessionId", "sessionFile", "cwd" }  hello is out
 *   { "type": "status", "status": "working" | "idle" }             turn boundaries
 *
 * Every frame sent or received is appended as JSONL to $FAKE_OMP_LOG with a
 * `__dir` of "out"/"in" — one frame per line, which is what the smokes'
 * `ompFrames()` helper reads. Lifecycle markers `__start`/`__exit` carry the
 * pid and argv.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

const LOG = process.env.FAKE_OMP_LOG ?? join(process.cwd(), "fake-omp.log");
const LINK = process.env.SHAPE_LINK;
/** the cwd every frame carries: what the agent routes on */
const CWD = process.env.SHAPE_WORKTREE ?? process.cwd();
const TURN_HOLD_MS = Number(process.env.FAKE_OMP_TURN_HOLD_MS ?? 0);
const SESSION_DIR = process.env.FAKE_OMP_SESSION_DIR ?? "/tmp/fake-omp-tui";

const argv = process.argv.slice(2);
const resumeAt = argv.indexOf("--resume");
const SESSION_ID = resumeAt === -1 ? `fake-tui-${process.pid}` : (argv[resumeAt + 1] ?? `fake-tui-${process.pid}`);
const SESSION_FILE = join(SESSION_DIR, `${SESSION_ID}.jsonl`);
const MODEL = { provider: "fake", id: "fake-1" };

function record(entry) {
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

function tell(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

if (LINK === undefined || LINK.length === 0) {
  process.stderr.write("fake-omp-tui: SHAPE_LINK is required\n");
  process.exit(2);
}

record({ type: "__start", pid: process.pid, cwd: CWD, argv, link: LINK, sessionId: SESSION_ID });

// ---------------------------------------------------------------------------
// The prompt -> canvas conventions: which regexes produce which ops, notes and
// cards. They came over verbatim from the rpc-mode fake this replaced, so every
// smoke expectation written against that script keeps its meaning here.
// ---------------------------------------------------------------------------

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

/** one legal enrich, one claim no file backs: the pair a drift check has to tell apart */
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

/** a build bubble the product-first gate must refuse */
const TOO_EARLY_OPS = [
  {
    op: "upsert_node",
    node: {
      id: "splitter-api",
      parentId: null,
      label: "Splitter API",
      summary: "Serves the split calculations to the app.",
      phase: "component",
    },
  },
];

const PICTURE_OPS = [
  {
    op: "upsert_node",
    node: {
      id: "product",
      parentId: null,
      layer: "product",
      label: "Bill Splitter",
      summary: "Lets a group of friends share costs and settle up without arguing.",
      phase: "idea",
    },
  },
  {
    op: "upsert_node",
    node: {
      id: "settle-up",
      parentId: "product",
      layer: "product",
      label: "Settle up",
      summary: "Tells each person the one payment that clears their debts.",
      phase: "idea",
    },
  },
];

/** the card a turn ends on: where things stand, two ways on, one open decision */
const NEXT_CARD = {
  summary: "The login part checks passwords, and nothing exports yet.",
  choices: [
    { label: "Build the export", say: "Build the export next and show me one." },
    { label: "Leave it for later", say: "Leave the export for later and tidy what is built." },
  ],
  question: "One file per note, or one file for the whole trip?",
};

/** a card no bridge should take: five choices, and a label past the cap */
const BAD_NEXT_CARD = {
  summary: "Where things stand.",
  choices: [
    { label: "x".repeat(60), say: "the first way on" },
    { label: "two", say: "the second way on" },
    { label: "three", say: "the third way on" },
    { label: "four", say: "the fourth way on" },
    { label: "five", say: "the fifth way on" },
  ],
  question: null,
};

/** the card that says the work is finished: nothing offered, nothing to decide */
const DONE_CARD = { summary: "Everything that was asked for is built.", choices: [], question: null };

/**
 * What a turn does with the sentence it was given: what it says, which canvas
 * batches it sends, and whether it touches a file. One place, so the fake's
 * behaviour is readable next to the expectations that depend on it.
 */
function planTurn(text) {
  if (/survey/i.test(text)) {
    return { says: ["surveying the workspace packages."], calls: [{ ops: SURVEY_OPS, note: "survey pass" }], tool: false };
  }
  if (/bad-op/i.test(text)) {
    return { says: ["probing receipts."], calls: [{ ops: BAD_OPS, note: "malformed batch" }], tool: false };
  }
  if (/product-first probe/i.test(text)) {
    return {
      says: ["sketching the product."],
      calls: [
        { ops: TOO_EARLY_OPS, note: "a part, too early" },
        { ops: PICTURE_OPS, note: "the product and one promise" },
      ],
      tool: false,
    };
  }
  // `next` is still accepted on the wire and still validated, so a turn can
  // end on a card: one that is fine, one the validator must refuse, one that
  // says the work is finished.
  const card = /bad-next probe/i.test(text)
    ? { say: "a card that will not do.", next: BAD_NEXT_CARD }
    : /finished probe/i.test(text)
      ? { say: "nothing left to do here.", next: DONE_CARD }
      : /next probe/i.test(text)
        ? { say: "the login part is done.", next: NEXT_CARD }
        : null;
  if (card !== null) {
    return { says: [card.say], calls: [{ ops: CANVAS_OPS, note: "where things stand", next: card.next }], tool: false };
  }
  return {
    says: [`ack: ${text.slice(0, 40)}`, " — sketching the canvas."],
    calls: [{ ops: CANVAS_OPS, note: "initial decomposition" }],
    tool: true,
  };
}

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

const socket = new WebSocket(LINK);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let callSeq = 0;
const pendingCanvas = new Map();
/** one turn at a time, exactly like a TUI: a prompt that arrives mid-turn waits */
let turns = Promise.resolve();

function send(frame) {
  record({ ...frame, __dir: "out" });
  socket.send(JSON.stringify(frame));
}

function event(ev) {
  send({ type: "agent_event", cwd: CWD, event: ev });
}

function setStreaming(on) {
  event({ kind: "state", state: on ? "streaming" : "idle" });
  tell({ type: "status", status: on ? "working" : "idle" });
}

async function callCanvas(args) {
  const id = `cv_${++callSeq}`;
  const { promise, resolve } = Promise.withResolvers();
  pendingCanvas.set(id, resolve);
  send({ type: "canvas_call", cwd: CWD, id, args });
  return promise;
}

/** the hold that keeps a turn open long enough for a test to watch it work */
async function hold() {
  if (TURN_HOLD_MS > 0) await sleep(TURN_HOLD_MS);
}

async function runTurn(text) {
  setStreaming(true);
  const plan = planTurn(text);
  for (const say of plan.says) event({ kind: "text_delta", delta: say });
  event({ kind: "text", text: plan.says.join("") });
  if (plan.tool) {
    const path = "packages/auth/src/index.ts";
    event({ kind: "tool_start", name: "write", paths: [path], summary: path });
    event({ kind: "tool_end", name: "write", isError: false });
  }
  for (const call of plan.calls) {
    const args = call.next === undefined ? { ops: call.ops, note: call.note } : { ops: call.ops, note: call.note, next: call.next };
    await callCanvas(args);
  }
  await hold();
  event({ kind: "turn_end" });
  setStreaming(false);
}

function bye(reason) {
  if (socket.readyState === WebSocket.OPEN) send({ type: "bye", cwd: CWD, reason });
  record({ type: "__exit", pid: process.pid, reason });
  // let the frame leave before the socket does
  setTimeout(() => process.exit(0), 20);
}

socket.addEventListener("open", () => {
  send({
    type: "hello",
    cwd: CWD,
    harness: "omp",
    sessionId: SESSION_ID,
    sessionFile: SESSION_FILE,
    model: MODEL,
    capabilities: { steer: true, tool: true },
  });
  event({ kind: "session", sessionId: SESSION_ID, sessionFile: SESSION_FILE, model: MODEL });
  tell({ type: "ready", pid: process.pid, sessionId: SESSION_ID, sessionFile: SESSION_FILE, cwd: CWD });
});

socket.addEventListener("message", (message) => {
  let frame;
  try {
    frame = JSON.parse(String(message.data));
  } catch {
    record({ type: "__unparseable", raw: String(message.data), __dir: "in" });
    return;
  }
  record({ ...frame, __dir: "in" });
  // every frame the link can send is an answer or a notice; nothing here
  // starts, steers or stops a turn, because Shape does not send work
  switch (frame.type) {
    case "canvas_result": {
      const resolve = pendingCanvas.get(frame.id);
      if (resolve !== undefined) {
        pendingCanvas.delete(frame.id);
        resolve(frame);
      }
      return;
    }
    case "error":
      return;
    default:
      return;
  }
});

socket.addEventListener("close", () => {
  record({ type: "__exit", pid: process.pid, reason: "link closed" });
  process.exit(0);
});

socket.addEventListener("error", (err) => {
  record({ type: "__error", message: String(err.message ?? "link error") });
});

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf("\n");
    if (line.length === 0) continue;
    let typed;
    try {
      typed = JSON.parse(line);
    } catch {
      record({ type: "__unparseable", raw: line, __dir: "stdin" });
      continue;
    }
    record({ ...typed, __dir: "stdin" });
    // a prompt typed into the pane is the only thing that starts a turn: the
    // user is at the terminal, and Shape only watches what comes of it
    if (typed.type === "typed") turns = turns.then(() => runTurn(String(typed.text ?? "")));
  }
});

process.on("SIGTERM", () => bye("terminated"));
process.on("SIGINT", () => bye("interrupted"));
