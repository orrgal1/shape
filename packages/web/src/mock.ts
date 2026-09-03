/**
 * `?mock=1` runs the canvas with no bridge at all: a hand-built GraphDoc that
 * exercises every visual state, plus a timer that moves the agent's activity
 * around so pulses are observable. Utterances echo into the transcript.
 *
 * `?mock=1&empty=1` is the brownfield entry state instead: a session whose
 * target already holds code but whose intent layer is still empty, which is
 * what the "Map this project" call to action is gated on.
 */
import {
  emptyGraph,
  type ClientMsg,
  type DiscoveredSession,
  type EntityDelta,
  type GraphDoc,
  type GraphEdge,
  type IntentNode,
  type RevisionInfo,
  type SessionInfo,
  type WorktreeInfo,
} from "../../shared/src/index.ts";
import { useApp } from "./store.ts";
import { isPlaygroundMock, startPlaygroundMock } from "./fixtures/playground.ts";

export function isMockMode(): boolean {
  return new URLSearchParams(window.location.search).get("mock") === "1" || isPlaygroundMock();
}

function isEmptyVariant(): boolean {
  return new URLSearchParams(window.location.search).get("empty") === "1";
}

function isTrioVariant(): boolean {
  return new URLSearchParams(window.location.search).get("trio") === "1";
}

/**
 * This repository's own root layer, which is the case that exposed the column
 * problem: three bubbles, two dataflow relations in the same direction between
 * the same pair, and one depends relation onward.
 */
export function trioGraph(): GraphDoc {
  return {
    rev: 7,
    nodes: [
      {
        id: "web-canvas",
        parentId: null,
        label: "Web canvas UI",
        summary: "Renders the living graph and turns clicks plus speech into steering.",
        phase: "building",
        status: "Reworking layout so small layers spread instead of stacking.",
        codeRefs: ["packages/web"],
      },
      {
        id: "bridge",
        parentId: null,
        label: "Bridge",
        summary: "Runs omp and keeps the canvas and the session in agreement.",
        phase: "built",
        codeRefs: ["packages/bridge"],
      },
      {
        id: "shared-contract",
        parentId: null,
        label: "Shared contract",
        summary: "The one machine-readable definition both halves are written against.",
        phase: "built",
        codeRefs: ["packages/shared"],
      },
    ],
    edges: [
      {
        id: "web-canvas--bridge",
        source: "web-canvas",
        target: "bridge",
        kind: "dataflow",
        label: "utterances",
      },
      {
        id: "web-canvas--bridge-2",
        source: "web-canvas",
        target: "bridge",
        kind: "dataflow",
        label: "session end",
      },
      {
        id: "bridge--shared-contract",
        source: "bridge",
        target: "shared-contract",
        kind: "depends",
        label: "session record",
      },
    ],
    reality: { nodes: [], edges: [], extractedAt: null, head: null },
    drift: {},
  };
}

/**
 * Three variations of the same project, including one with a detached head, so
 * the switcher's branch-name and fall-back-to-path paths are both exercised.
 */
const MOCK_WORKTREES: readonly WorktreeInfo[] = [
  { path: "/Users/you/code/vireo", branch: "main", head: "8f2c1ab", current: true },
  { path: "/Users/you/code/vireo-offline-sync", branch: "offline-sync", head: "3d91c04", current: false },
  { path: "/Users/you/code/vireo-spike", branch: null, head: "b71e2fa", current: false },
];

export function mockSession(targetHasCode: boolean): SessionInfo {
  return {
    sessionId: "mock-session",
    sessionName: "vireo field notebook",
    model: { provider: "anthropic", id: "claude-fable-5" },
    cwd: "/Users/you/code/vireo",
    targetHasCode,
    worktrees: MOCK_WORKTREES.map((entry) => ({ ...entry })),
    backend: {
      id: "omp",
      label: "omp",
      capabilities: { steerMidTurn: true, hostTool: true, events: "native", resume: true, terminal: "shell" },
    },
  };
}

const MOCK_RECENTS: readonly string[] = [
  "/Users/you/code/vireo",
  "/Users/you/code/shape",
  "/Users/you/code/pomo",
  "/Users/you/work/atlas-api",
];

const MINUTE_MS = 60_000;

/**
 * Three sessions the adopt list can offer: one omp with a resumable id, one
 * Claude Code with a live IPC socket, and one Codex whose cwd is a worktree of
 * the fixture project. Covers the harness badge, the resume tag and the
 * "nothing to attach to" case.
 */
const MOCK_SESSIONS: readonly DiscoveredSession[] = [
  {
    harness: "omp",
    pid: 4821,
    command: "omp",
    cwd: "/Users/you/code/pomo",
    sessionId: "01a05f7c-2b41-7f00-9d3a-6c1e4b8a0d92",
    sessionFile: "/Users/you/.omp/agent/sessions/--Users-you-code-pomo/2026-09-02T09-12-04Z.jsonl",
    startedAt: new Date(Date.now() - 62 * MINUTE_MS).toISOString(),
    resumeCommand: ["omp", "--resume", "01a05f7c-2b41-7f00-9d3a-6c1e4b8a0d92"],
    attach: "none",
    spawnedByShape: false,
  },
  {
    harness: "claude",
    pid: 5107,
    command: "claude",
    cwd: "/Users/you/work/atlas-api",
    sessionId: "9f31c0de-7ab2-4c15-8f60-2d7e9a441bb3",
    sessionFile: "/Users/you/.claude/projects/-Users-you-work-atlas-api/9f31c0de.jsonl",
    startedAt: new Date(Date.now() - 18 * MINUTE_MS).toISOString(),
    resumeCommand: ["claude", "--resume", "9f31c0de-7ab2-4c15-8f60-2d7e9a441bb3"],
    attach: "socket",
    spawnedByShape: false,
  },
  {
    harness: "codex",
    pid: 5620,
    command: "codex",
    cwd: "/Users/you/code/vireo-offline-sync",
    sessionId: null,
    sessionFile: null,
    startedAt: new Date(Date.now() - 3 * MINUTE_MS).toISOString(),
    resumeCommand: null,
    attach: "daemon",
    spawnedByShape: false,
  },
];

/**
 * Three saved versions of the fixture canvas, timed relative to page load so the
 * picker reads the way it would against a real bridge. The newest one is the
 * graph on screen, which is what lets a comparison against it show the
 * unchanged remainder as backdrop.
 */
function mockRevisions(rev: number): RevisionInfo[] {
  const now = Date.now();
  return [
    { rev: rev - 4, at: new Date(now - 190 * MINUTE_MS).toISOString() },
    { rev: rev - 2, at: new Date(now - 41 * MINUTE_MS).toISOString() },
    { rev, at: new Date(now - 4 * MINUTE_MS).toISOString() },
  ];
}

export function sampleGraph(): GraphDoc {
  return {
    rev: 41,
    nodes: [
      {
        id: "capture",
        parentId: null,
        label: "Capture",
        summary: "Turns a spoken field note into a structured observation record.",
        phase: "building",
        status: "Wiring the transcriber hand-off; mic path is done.",
        modelRole: "build",
        kind: "service",
        codeRefs: ["packages/capture"],
      },
      {
        id: "mic-stream",
        parentId: "capture",
        label: "Mic stream",
        summary: "Delivers 16 kHz mono frames with backpressure to the transcriber.",
        phase: "built",
        kind: "queue",
        codeRefs: ["packages/capture/mic"],
      },
      {
        id: "transcriber",
        parentId: "capture",
        label: "Transcriber",
        summary: "Converts audio frames into punctuated text with word timings.",
        phase: "building",
        status: "Punctuation pass is failing on multi-sentence audio.",
      },
      {
        id: "whisper-worker",
        parentId: "transcriber",
        label: "Whisper worker",
        summary: "Runs the local model off the main thread, one utterance at a time.",
        phase: "built",
        modelRole: "small",
        codeRefs: ["packages/capture/asr"],
      },
      {
        id: "punctuator",
        parentId: "transcriber",
        label: "Punctuator",
        summary: "Restores sentence boundaries the acoustic model drops.",
        phase: "failed",
        status: "Drops the second sentence of every two-sentence utterance.",
      },
      {
        id: "notebook",
        parentId: null,
        label: "Notebook",
        summary: "Holds every observation and keeps devices in agreement about it.",
        phase: "concept",
        kind: "store",
      },
      {
        id: "entry-store",
        parentId: "notebook",
        label: "Entry store",
        summary: "Append-only local log of observations, addressable by note id.",
        phase: "component",
        kind: "store",
        codeRefs: ["packages/store"],
      },
      {
        id: "sync-engine",
        parentId: "notebook",
        label: "Sync engine",
        summary: "Reconciles offline edits without losing a field observation.",
        phase: "building",
        status: "Writing the last-writer-wins merge for offline edits.",
        codeRefs: ["packages/store/sync"],
      },
      {
        id: "taxonomy",
        parentId: null,
        label: "Taxonomy",
        summary: "Infers species and habitat tags from the text of a note.",
        phase: "concept",
        modelRole: "explore",
      },
      {
        id: "field-map",
        parentId: null,
        label: "Field map",
        summary: "Places each observation on the walked route for later review.",
        phase: "idea",
        kind: "ui",
      },
      {
        id: "export-kit",
        parentId: null,
        label: "Export kit",
        summary: "Emits Darwin Core archives a herbarium will actually accept.",
        phase: "idea",
        kind: "external",
      },
      {
        id: "identity",
        parentId: null,
        label: "Identity",
        summary: "Issues device keys so a phone can sync without an account.",
        phase: "component",
        kind: "security",
        modelRole: "small",
        codeRefs: ["packages/identity"],
      },
      {
        id: "field-api",
        parentId: null,
        label: "Field API",
        summary: "Serves observations over HTTP so partner portals can query them.",
        phase: "idea",
        kind: "api",
      },
      // --- the product layer: the product itself, then what it promises a
      // person and which of the bubbles above make each promise real. One
      // capability promises nothing yet on purpose (`share-notes`), which is
      // what the unrealized glow and its side-panel note are drawn from.
      {
        id: "vireo",
        parentId: null,
        label: "Vireo field notebook",
        summary: "Speak what you see on a walk and come home with a notebook you can search, name and hand on.",
        phase: "building",
        layer: "product",
      },
      {
        id: "log-sighting",
        parentId: "vireo",
        label: "Log a sighting",
        summary: "Speak what you see and have a filed observation by the time you look up.",
        phase: "building",
        status: "Two-sentence notes still lose their second half.",
        layer: "product",
        realizes: ["capture"],
      },
      {
        id: "notes-everywhere",
        parentId: "vireo",
        label: "Keep notes on every device",
        summary: "Write in the field with no signal and find it on the laptop that evening.",
        phase: "component",
        layer: "product",
        realizes: ["notebook", "identity"],
      },
      {
        id: "name-what-i-saw",
        parentId: "vireo",
        label: "Name what I saw",
        summary: "Turn a description into a species and a habitat you can search by.",
        phase: "concept",
        layer: "product",
        realizes: ["taxonomy"],
      },
      {
        id: "share-notes",
        parentId: "vireo",
        label: "Hand notes to a herbarium",
        summary: "Send a season of observations somewhere they will be kept and cited.",
        phase: "component",
        layer: "product",
        realizes: [],
      },
    ],
    edges: [
      { id: "capture--notebook", source: "capture", target: "notebook", kind: "dataflow", label: "observations" },
      // a second relation between the same two subtrees, so the root layer has a
      // genuine bundle to lift and count rather than a single hidden edge
      {
        id: "transcriber--entry-store",
        source: "transcriber",
        target: "entry-store",
        kind: "dataflow",
        label: "transcripts",
      },
      { id: "mic-stream--transcriber", source: "mic-stream", target: "transcriber", kind: "dataflow", label: "pcm frames" },
      { id: "whisper-worker--punctuator", source: "whisper-worker", target: "punctuator", kind: "depends" },
      { id: "transcriber--taxonomy", source: "transcriber", target: "taxonomy", kind: "depends" },
      { id: "sync-engine--identity", source: "sync-engine", target: "identity", kind: "depends", label: "device key" },
      { id: "entry-store--export-kit", source: "entry-store", target: "export-kit", kind: "dataflow", label: "note batches" },
      { id: "taxonomy--field-map", source: "taxonomy", target: "field-map", kind: "relates", label: "shared vocabulary" },
      { id: "field-map--export-kit", source: "field-map", target: "export-kit", kind: "relates" },
      // third relation into export-kit, so the sample exercises the vendored
      // port spread: three anchors fanned along one side instead of one point
      { id: "taxonomy--export-kit", source: "taxonomy", target: "export-kit", kind: "dataflow", label: "tag sheets" },
      { id: "notebook--field-api", source: "notebook", target: "field-api", kind: "dataflow", label: "published notes" },
      { id: "field-api--identity", source: "field-api", target: "identity", kind: "depends", label: "access tokens" },
      // product-layer relations: capabilities meeting each other, in the words a
      // person would use about their own day
      {
        id: "log-sighting--notes-everywhere",
        source: "log-sighting",
        target: "notes-everywhere",
        kind: "dataflow",
        label: "the note it just filed",
      },
      {
        id: "notes-everywhere--share-notes",
        source: "notes-everywhere",
        target: "share-notes",
        kind: "dataflow",
        label: "the season worth publishing",
      },
      {
        id: "name-what-i-saw--log-sighting",
        source: "name-what-i-saw",
        target: "log-sighting",
        kind: "relates",
        label: "the same words for the same creature",
      },
    ],
    reality: {
      nodes: [
        { id: "r:app", label: "@vireo/app", dir: "packages/app" },
        { id: "r:store", label: "@vireo/store", dir: "packages/store" },
        { id: "r:capture", label: "@vireo/capture", dir: "packages/capture" },
        { id: "r:identity", label: "@vireo/identity", dir: "packages/identity" },
      ],
      edges: [
        { id: "r:app--r:store", source: "r:app", target: "r:store" },
        { id: "r:store--r:capture", source: "r:store", target: "r:capture" },
        { id: "r:app--r:identity", source: "r:app", target: "r:identity" },
      ],
    extractedAt: "2026-08-28T09:14:02.000Z",
      head: "8f2c1ab",
    },
    drift: {
      "entry-store": [
        "packages/store imports packages/capture, but no edge declares that dependency.",
        "Declared dataflow to export-kit has no import path in the code yet.",
      ],
    },
  };
}

/** the agent moves between bubbles; this makes that motion visible */
const ACTIVITY_CYCLE: readonly string[][] = [
  ["sync-engine"],
  ["punctuator", "whisper-worker"],
  ["capture", "mic-stream"],
  ["taxonomy"],
];
const ACTIVITY_PERIOD_MS = 2000;

export function startMock(): () => void {
  const store = useApp.getState();
  if (isPlaygroundMock()) return startPlaygroundMock();

  if (isEmptyVariant()) {
    // brownfield entry: code on disk, nothing mapped yet
    store.ingest({
      type: "hello",
      graph: emptyGraph(),
      session: mockSession(true),
      agent: "idle",
      recentProjects: [...MOCK_RECENTS],
      sessions: MOCK_SESSIONS.map((entry) => ({ ...entry })),
      revisions: [],
    });
    // after `hello`, which would otherwise report a live bridge
    store.setConn("mock");
    return () => {};
  }

  if (isTrioVariant()) {
    store.ingest({
      type: "hello",
      graph: trioGraph(),
      session: mockSession(true),
      agent: "idle",
      recentProjects: [...MOCK_RECENTS],
      sessions: MOCK_SESSIONS.map((entry) => ({ ...entry })),
      revisions: mockRevisions(7),
    });
    store.setConn("mock");
    store.ingest({ type: "activity", nodeIds: ["web-canvas"] });
    return () => {};
  }

  store.ingest({
    type: "hello",
    graph: sampleGraph(),
    session: mockSession(false),
    agent: "streaming",
    recentProjects: [...MOCK_RECENTS],
    sessions: MOCK_SESSIONS.map((entry) => ({ ...entry })),
    revisions: mockRevisions(41),
  });
  store.setConn("mock");
  store.ingest({
    type: "transcript",
    role: "user",
    text: "Start with field capture — voice in, structured observation out.",
  });
  store.ingest({
    type: "transcript",
    role: "assistant",
    text: "Decomposed capture into a mic stream and a transcriber. The transcriber splits again: a whisper worker for acoustics and a punctuator for sentence boundaries.",
  });
  store.ingest({
    type: "transcript",
    role: "tool",
    text: "canvas: applied 5 op(s); rev=39",
  });
  store.ingest({
    type: "transcript",
    role: "assistant",
    text: "The punctuator is failing on multi-sentence utterances; I am reading the timing data before changing the model.",
  });
  store.ingest({
    type: "transcript",
    role: "tool",
    text: "read packages/capture/asr/punctuate.ts:1-80",
  });
  store.ingest({
    type: "transcript",
    role: "tool",
    text: "write packages/store/sync/merge.ts",
  });

  let index = 0;
  const timer = window.setInterval(() => {
    const nodeIds = ACTIVITY_CYCLE[index % ACTIVITY_CYCLE.length] ?? [];
    index += 1;
    useApp.getState().ingest({ type: "activity", nodeIds: [...nodeIds] });
  }, ACTIVITY_PERIOD_MS);

  useApp.getState().ingest({ type: "activity", nodeIds: ["sync-engine", "transcriber"] });

  return () => window.clearInterval(timer);
}

export function mockSend(msg: ClientMsg): void {
  const store = useApp.getState();
  // mock mode is also how the adopt UI is verified: every outbound frame is
  // announced, because there is no socket to watch for it
  console.info(`[mock] client frame ${JSON.stringify(msg)}`);
  if (msg.type === "abort") {
    store.ingest({ type: "agent", state: "idle" });
    store.appendTranscript("tool", "abort requested (mock)");
    return;
  }
  if (msg.type === "onboard") {
    store.appendTranscript(
      "tool",
      msg.focus === undefined
        ? "onboard requested (mock: no bridge attached, so no skeleton lands)"
        : `onboard requested, focus "${msg.focus}" (mock: no bridge attached)`,
    );
    return;
  }
  if (msg.type === "switch_project") {
    // a real bridge answers with a fresh hello; the mock has one project, so it
    // reports what it would have done instead of faking a second graph
    store.pushError(`switch_project "${msg.path}" needs the bridge — mock mode has one fixture project`);
    return;
  }
  if (msg.type === "discover") {
    // the fixture list is fixed, so a re-scan legitimately answers the same rows
    store.ingest({ type: "sessions", sessions: MOCK_SESSIONS.map((entry) => ({ ...entry })) });
    store.appendTranscript("tool", `discover: ${MOCK_SESSIONS.length} running session(s) (mock)`);
    return;
  }
  if (msg.type === "adopt") {
    const found = MOCK_SESSIONS.find((entry) => entry.pid === msg.pid);
    if (found === undefined) {
      store.pushError(`adopt rejected: no running agent session with pid ${msg.pid} (mock)`);
      return;
    }
    // adopting is a bridge-side retarget; the mock reports the intent instead
    store.appendTranscript("tool", `adopt ${found.harness} pid ${found.pid} in ${found.cwd ?? "?"} (mock)`);
    store.pushError(`adopt needs the bridge — mock mode cannot attach to ${found.harness} pid ${found.pid}`);
    return;
  }
  if (msg.type === "diff") {
    // There is no snapshot store here, so the mock fabricates a plausible answer
    // about the graph on screen: its first bubble was reworded and re-phased, its
    // second bubble is new, its first relation is new, and one bubble plus one
    // relation that no longer exist were dropped. Enough to exercise all three
    // treatments, honest about being fiction like the rest of this file.
    const doc = store.doc;
    const first = doc.nodes[0];
    const second = doc.nodes[1];
    const firstEdge = doc.edges[0];
    const nodes: EntityDelta<IntentNode> = { added: [], removed: [], changed: [] };
    const edges: EntityDelta<GraphEdge> = { added: [], removed: [], changed: [] };

    if (second !== undefined) nodes.added.push(second);
    if (first !== undefined) {
      nodes.changed.push({
        before: { ...first, phase: "idea", summary: "An earlier, vaguer version of the same promise." },
        after: first,
      });
    }
    nodes.removed.push({
      id: "paper-backup",
      parentId: null,
      label: "Paper backup",
      summary: "Kept a printable copy of every note for the field.",
      phase: "concept",
    });
    if (firstEdge !== undefined) edges.added.push(firstEdge);
    if (first !== undefined) {
      edges.removed.push({
        id: "paper-backup--first",
        source: "paper-backup",
        target: first.id,
        kind: "relates",
        label: "printed from",
      });
    }

    store.ingest({ type: "delta", delta: { revA: msg.revA, revB: msg.revB, nodes, edges } });
    return;
  }
  // the mock has no shell: pty frames are the terminal pane's business
  if (msg.type !== "utterance") return;
  const where = msg.referent === null ? "whole project" : `${msg.referent.kind} ${msg.referent.id}`;
  store.appendTranscript("user", msg.text);
  store.appendTranscript("tool", `steer -> ${where} (mock: no bridge attached)`);
}
