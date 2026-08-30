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
  type GraphDoc,
  type SessionInfo,
  type WorktreeInfo,
} from "../../shared/src/index.ts";
import { useApp } from "./store.ts";

export function isMockMode(): boolean {
  return new URLSearchParams(window.location.search).get("mock") === "1";
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

function mockSession(targetHasCode: boolean): SessionInfo {
  return {
    sessionId: "mock-session",
    sessionName: "vireo field notebook",
    model: { provider: "anthropic", id: "claude-fable-5" },
    cwd: "/Users/you/code/vireo",
    targetHasCode,
    worktrees: MOCK_WORKTREES.map((entry) => ({ ...entry })),
  };
}

const MOCK_RECENTS: readonly string[] = [
  "/Users/you/code/vireo",
  "/Users/you/code/visual-harness",
  "/Users/you/code/pomo",
  "/Users/you/work/atlas-api",
];

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

  if (isEmptyVariant()) {
    // brownfield entry: code on disk, nothing mapped yet
    store.ingest({
      type: "hello",
      graph: emptyGraph(),
      session: mockSession(true),
      agent: "idle",
      recentProjects: [...MOCK_RECENTS],
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
  const where = msg.referent === null ? "whole project" : `${msg.referent.kind} ${msg.referent.id}`;
  store.appendTranscript("user", msg.text);
  store.appendTranscript("tool", `steer -> ${where} (mock: no bridge attached)`);
}
