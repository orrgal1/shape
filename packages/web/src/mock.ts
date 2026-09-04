/**
 * `?mock=1` runs the canvas with no bridge at all: a hand-built GraphDoc that
 * exercises every visual state, plus a timer that moves the agent's activity
 * around so pulses are observable. Utterances echo into the transcript.
 *
 * `?mock=1&empty=1` is the brownfield entry state instead: a session whose
 * target already holds code the extractor has read — so the reality strip is on
 * the canvas — but whose intent layer is still empty, which is what the compact
 * "not mapped yet" card and the "Map this project" call to action are for.
 */
import {
  emptyGraph,
  type AgentState,
  type BackendInfo,
  type ClientMsg,
  type DiscoveredSession,
  type EntityDelta,
  type GraphDoc,
  type GraphEdge,
  type IntentNode,
  type Next,
  type ProjectSummary,
  type ProjectTools,
  type RevisionInfo,
  type ServerMsg,
  type SessionInfo,
  type WorktreeInfo,
  type WorktreeSession,
} from "../../shared/src/index.ts";
import { useApp, type TranscriptRole } from "./store.ts";
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
 * A checkout with code in it and nothing mapped: no intent nodes at all, and a
 * reality layer the extractor filled in — five packages and the imports between
 * them. This is the live shape of the situation that read as a stuck splash,
 * so it is the fixture the compact empty state is judged against.
 */
function unmappedGraph(): GraphDoc {
  const doc = emptyGraph();
  return {
    ...doc,
    reality: {
      ...doc.reality,
      nodes: [
        { id: "r:app", label: "@vireo/app", dir: "packages/app" },
        { id: "r:store", label: "@vireo/store", dir: "packages/store" },
        { id: "r:capture", label: "@vireo/capture", dir: "packages/capture" },
        { id: "r:identity", label: "@vireo/identity", dir: "packages/identity" },
        { id: "r:export-kit", label: "@vireo/export-kit", dir: "packages/export-kit" },
      ],
      edges: [
        { id: "r:app--r:store", source: "r:app", target: "r:store" },
        { id: "r:store--r:capture", source: "r:store", target: "r:capture" },
        { id: "r:app--r:identity", source: "r:app", target: "r:identity" },
        { id: "r:store--r:export-kit", source: "r:store", target: "r:export-kit" },
      ],
      extractedAt: "2026-08-28T09:14:02.000Z",
      head: "8f2c1ab",
    },
  };
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
    reality: { nodes: [], edges: [], symbols: [], infra: [], verification: [], extractedAt: null, head: null },
    drift: {},
  };
}

/** the main worktree of the fixture project, and the two beside it */
const MOCK_MAIN = "/Users/you/code/vireo";
const MOCK_SPIKE = "/Users/you/code/vireo-spike-voice";
const MOCK_QUIET = "/Users/you/code/vireo-offline-sync";

/**
 * Three variations of the same project: two with a harness running in them, so
 * the merge, the pips, the per-variation rings and the target chip are all
 * visible with no bridge, and one detached checkout with no session at all,
 * which is what the "open" action in the variations menu is for.
 */
const MOCK_WORKTREES: readonly WorktreeInfo[] = [
  { id: MOCK_MAIN, path: MOCK_MAIN, branch: "main", head: "8f2c1ab" },
  { id: MOCK_SPIKE, path: MOCK_SPIKE, branch: "spike/voice", head: "3d91c04" },
  { id: MOCK_QUIET, path: MOCK_QUIET, branch: null, head: "b71e2fa" },
];

/**
 * The two harnesses the fixture runs, and the two answers a "Go to terminal"
 * click can get: the main variation's session lives in the user's own terminal
 * (herdr brought it forward, nothing changes on this screen), and the spike's
 * was started before herdr was installed, so Shape owns its pty and shows it in
 * the drawer.
 */
const MOCK_BACKEND: BackendInfo = {
  id: "omp",
  label: "omp",
  capabilities: { steerMidTurn: true, hostTool: true, events: "native", resume: true, terminal: "external" },
};

const MOCK_PANE_BACKEND: BackendInfo = {
  id: "claude",
  label: "Claude Code",
  capabilities: { steerMidTurn: false, hostTool: true, events: "hooks", resume: true, terminal: "pane" },
};

/** what the fixture machine has installed: herdr to launch with, two harnesses to launch */
function mockTools(): ProjectTools {
  return {
    launcher: "herdr",
    launchers: [{ id: "herdr", label: "herdr", path: "/usr/local/bin/herdr", version: "0.9.2" }],
    harnesses: [
      { id: "omp", label: "omp", path: "/usr/local/bin/omp", version: "2.1.0" },
      { id: "claude", label: "Claude Code", path: "/usr/local/bin/claude", version: "1.4.7" },
    ],
  };
}

/** the harnesses running in the fixture: one per variation the user opened */
function mockRunning(): WorktreeSession[] {
  return [
    {
      worktree: MOCK_MAIN,
      session: { sessionId: "mock-session", sessionName: "vireo field notebook", model: MOCK_MODEL },
      backend: MOCK_BACKEND,
      state: "streaming",
    },
    {
      worktree: MOCK_SPIKE,
      session: { sessionId: "mock-spike", sessionName: "voice-first capture", model: MOCK_MODEL },
      backend: MOCK_PANE_BACKEND,
      state: "streaming",
    },
  ];
}

const MOCK_MODEL = { provider: "anthropic", id: "claude-fable-5" };

/**
 * Where each variation's last turn left things. Both cards are the shape the
 * real thing takes: the main one ends on a decision the user has to make, the
 * spike ends on choices only — so the card, its question line and the "or say
 * it your way" hint are all reachable with no bridge.
 */
function mockNexts(): Record<string, Next | null> {
  return {
    [MOCK_MAIN]: {
      summary: "The notebook saves recordings and writes them up, and the export kit is the last piece left.",
      choices: [
        { label: "Build the export kit", say: "Build the export kit next and show me what a finished export looks like." },
        { label: "Show me a walkthrough", say: "Walk me through what happens when I record a note today." },
        { label: "Leave export for later", say: "Leave the export kit for later and tidy up what is already built." },
      ],
      question: "Should an export be one file per recording, or one file for the whole trip?",
    },
    [MOCK_SPIKE]: {
      summary: "Voice macros work end to end on this branch, but nothing proves they keep working.",
      choices: [
        { label: "Add the checks", say: "Add checks that prove the voice macros keep working, then mark them done." },
        { label: "Merge it into main", say: "Bring the voice macros over to the main line of work." },
      ],
      question: null,
    },
    [MOCK_QUIET]: null,
  };
}

/** nothing runs on its own until the toggle is clicked, exactly like a fresh bridge */
function mockAutonomous(): Record<string, boolean> {
  return { [MOCK_MAIN]: false, [MOCK_SPIKE]: false, [MOCK_QUIET]: false };
}

export function mockSession(targetHasCode: boolean): SessionInfo {
  return {
    cwd: MOCK_MAIN,
    targetHasCode,
    worktrees: MOCK_WORKTREES.map((entry) => ({ ...entry })),
    sessions: mockRunning(),
    agentConnected: true,
    // the fixture offers the GitHub option so the create form's full shape is reachable
    canPublish: true,
    // the mock has no agent behind it, so there is no directive on disk
    directivePath: null,
  };
}

/**
 * The same project on the `spike/voice` branch: one bubble it does not have
 * (the export kit was never started there), one it alone has, and two that say
 * something else — which is exactly what a pip, a hollow pip and the side
 * panel's "where" section are drawn from.
 */
export function voiceSpikeGraph(): GraphDoc {
  const doc = sampleGraph();
  const gone = "export-kit";
  const nodes: IntentNode[] = [];
  for (const node of doc.nodes) {
    if (node.id === gone) continue;
    if (node.id === "punctuator") {
      nodes.push({ ...node, phase: "built", status: "Sentence boundaries hold on the recorded set." });
      continue;
    }
    if (node.id === "capture") {
      nodes.push({
        ...node,
        summary: "Turns a spoken field note into a structured observation, hands-free from the first word.",
        status: "Wake-word path is in; the mic never stops listening on this branch.",
      });
      continue;
    }
    nodes.push(node);
  }
  nodes.push({
    id: "voice-macros",
    parentId: null,
    label: "Voice macros",
    summary: "Turns a spoken shorthand into a whole observation, so a walk needs no sentences.",
    phase: "building",
    status: "Teaching it the twelve calls a ringer actually uses.",
    kind: "service",
  });
  return {
    ...doc,
    rev: 44,
    nodes,
    edges: [
      ...doc.edges.filter((edge) => edge.source !== gone && edge.target !== gone),
      {
        id: "transcriber--voice-macros",
        source: "transcriber",
        target: "voice-macros",
        kind: "dataflow",
        label: "spoken shorthand",
      },
    ],
  };
}

const MOCK_RECENTS: readonly string[] = [
  "/Users/you/code/vireo",
  "/Users/you/code/shape",
  "/Users/you/code/pomo",
  "/Users/you/work/atlas-api",
];

const MINUTE_MS = 60_000;

/** what a real agent derives from machine + realpath(cwd); fixed here */
const MOCK_PROJECT_ID = "mock-machine:/Users/you/code/vireo";

/**
 * The fixture server hosts exactly one project, and `hello` names that same id
 * — which is what keeps the picker's project list correctly hidden.
 */
function mockProjects(): ProjectSummary[] {
  return [
    {
      projectId: MOCK_PROJECT_ID,
      label: "vireo",
      cwd: "/Users/you/code/vireo",
      harness: "omp",
      agentConnected: true,
      lastSeen: new Date(Date.now() - MINUTE_MS).toISOString(),
    },
  ];
}

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
        // a symbol ref beside the path one: this bubble IS that class, which is
        // what keeps `WhisperWorker` out of its own mechanical listing
        codeRefs: ["packages/capture/asr", "packages/capture/asr/worker.ts#WhisperWorker"],
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
      // --- the infra layer: where those parts run and what they lean on. No
      // root bubble: a handful of top-level pieces is what infrastructure looks
      // like. `hosts` is the link back to the build side, which is what the
      // "runs N parts" chip opens.
      {
        id: "app-host",
        parentId: null,
        label: "Where the app runs",
        summary: "One small always-on machine per region, restarted on every deploy.",
        phase: "built",
        layer: "infra",
        kind: "host",
        codeRefs: ["fly.toml"],
        hosts: ["capture", "notebook", "field-api"],
      },
      {
        id: "notes-database",
        parentId: null,
        label: "The notes database",
        summary: "Holds every filed observation, and the only thing here that must never lose a write.",
        phase: "built",
        layer: "infra",
        kind: "database",
        codeRefs: ["docker-compose.yml"],
        hosts: ["entry-store", "sync-engine"],
      },
      {
        id: "tile-cache",
        parentId: null,
        label: "The map tile cache",
        summary: "Keeps walked-route tiles near the phone so a map opens without signal.",
        phase: "component",
        layer: "infra",
        kind: "cache",
        codeRefs: ["infra/redis.conf"],
        hosts: ["field-map"],
      },
      {
        id: "build-pipeline",
        parentId: null,
        label: "The build-and-test pipeline",
        summary: "Runs the tests and ships the app on every push to the main branch.",
        phase: "built",
        layer: "infra",
        kind: "ci",
        codeRefs: [".github/workflows/ci.yml"],
        hosts: ["capture", "identity"],
      },
      // --- the correctness layer: what proves those parts work. No root bubble
      // either, for the same reason infrastructure has none. `verifies` is the
      // link back to the build side, which is what the "verifies N parts" chip
      // opens, and what fills a build bubble's shield.
      {
        id: "capture-tests",
        parentId: null,
        label: "The capture test suite",
        summary: "Runs recorded field audio through the whole capture path and checks what comes out.",
        phase: "built",
        layer: "correctness",
        kind: "test",
        codeRefs: ["packages/capture/test"],
        verifies: ["capture"],
      },
      {
        id: "sync-smoke",
        parentId: null,
        label: "The offline sync smoke run",
        summary: "Writes a note with the network off, brings it back, and checks nothing was lost.",
        phase: "component",
        layer: "correctness",
        kind: "smoke",
        codeRefs: ["scripts/smoke-sync.mjs"],
        verifies: ["entry-store", "sync-engine"],
      },
      {
        id: "push-checks",
        parentId: null,
        label: "Checks run on every push",
        summary: "Types and lint over the whole tree before anything is allowed to merge.",
        phase: "built",
        layer: "correctness",
        kind: "check",
        codeRefs: [".github/workflows/ci.yml"],
        verifies: ["identity"],
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
      // The mechanical inside of two leaves. Six of them sit under "Mic stream",
      // which is one more than a layer draws — so that drill is also where the
      // ghost column's own fold is exercised. `WhisperWorker` is named by the
      // whisper-worker bubble's own `file#Name` ref, so it is claimed and the
      // listing under that bubble is only what is left.
      symbols: [
        {
          id: "s:packages/capture/mic/stream.ts#MicStream",
          file: "packages/capture/mic/stream.ts",
          name: "MicStream",
          kind: "class",
          exported: true,
          line: 18,
          pkg: "r:capture",
        },
        {
          id: "s:packages/capture/mic/stream.ts#FrameQueue",
          file: "packages/capture/mic/stream.ts",
          name: "FrameQueue",
          kind: "class",
          exported: true,
          line: 74,
          pkg: "r:capture",
        },
        {
          id: "s:packages/capture/mic/stream.ts#openMic",
          file: "packages/capture/mic/stream.ts",
          name: "openMic",
          kind: "function",
          exported: true,
          line: 121,
          pkg: "r:capture",
        },
        {
          id: "s:packages/capture/mic/stream.ts#resample",
          file: "packages/capture/mic/stream.ts",
          name: "resample",
          kind: "function",
          exported: false,
          line: 164,
          pkg: "r:capture",
        },
        {
          id: "s:packages/capture/mic/level.ts#levelMeter",
          file: "packages/capture/mic/level.ts",
          name: "levelMeter",
          kind: "function",
          exported: true,
          line: 12,
          pkg: "r:capture",
        },
        {
          id: "s:packages/capture/mic/level.ts#clamp",
          file: "packages/capture/mic/level.ts",
          name: "clamp",
          kind: "function",
          exported: false,
          line: 40,
          pkg: "r:capture",
        },
        {
          id: "s:packages/capture/asr/worker.ts#WhisperWorker",
          file: "packages/capture/asr/worker.ts",
          name: "WhisperWorker",
          kind: "class",
          exported: true,
          line: 22,
          pkg: "r:capture",
        },
        {
          id: "s:packages/capture/asr/worker.ts#decodeChunk",
          file: "packages/capture/asr/worker.ts",
          name: "decodeChunk",
          kind: "function",
          exported: false,
          line: 96,
          pkg: "r:capture",
        },
      ],
      // Two of these are already on the canvas — the infra bubbles name their
      // config files — so only the bucket nothing admits to using is ghosted.
      infra: [
        {
          id: "i:fly",
          label: "fly.io app “vireo”",
          kind: "host",
          evidence: ["fly.toml"],
          hint: "a fly.io app read out of fly.toml",
        },
        {
          id: "i:postgres",
          label: "Postgres 16",
          kind: "database",
          evidence: ["docker-compose.yml"],
          hint: "a Postgres database from docker-compose.yml",
        },
        {
          id: "i:exports-bucket",
          label: "S3 bucket “vireo-exports”",
          kind: "store",
          evidence: ["infra/terraform/storage.tf"],
          hint: "an S3 bucket declared in Terraform that nothing on the canvas uses yet",
        },
      ],
      // Three of these are already on the canvas — the correctness bubbles name
      // the files they were read from — so only the checklist nothing admits to
      // running is ghosted. `covers` is the other half: it is what makes
      // Identity read as attested with no `verifies` link pointing at it, which
      // is the mechanical row the side panel lists under "verified by".
      verification: [
        {
          id: "v:capture-tests",
          label: "Tests in packages/capture (12 files)",
          kind: "test",
          evidence: ["packages/capture/test/mic.test.ts", "vitest.config.ts"],
          hint: "12 test files under packages/capture, run by vitest",
          covers: ["packages/capture"],
        },
        {
          id: "v:sync-smoke",
          label: "Smoke checks: smoke-sync",
          kind: "smoke",
          evidence: ["scripts/smoke-sync.mjs"],
          hint: "a script that writes a note offline and reads it back",
          covers: ["packages/store/sync"],
        },
        {
          id: "v:push-checks",
          label: "Static checks: typecheck, lint",
          kind: "check",
          evidence: [".github/workflows/ci.yml"],
          hint: "types and lint over the whole tree on every push",
          covers: ["packages/capture", "packages/store", "packages/identity"],
        },
        {
          id: "v:release-review",
          label: "The release checklist",
          kind: "review",
          evidence: ["docs/release-checklist.md"],
          hint: "a checklist somebody walks through by hand that no bubble accounts for",
          covers: ["packages/app"],
        },
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

/**
 * What both harnesses have said so far, each line tagged with the variation it
 * came from — which is what lets the side panel read as one stream while the
 * "now" pill still says which branch is doing what.
 */
const MOCK_TRANSCRIPT: readonly { worktree: string; role: TranscriptRole; text: string }[] = [
  {
    worktree: MOCK_MAIN,
    role: "user",
    text: "Start with field capture — voice in, structured observation out.",
  },
  {
    worktree: MOCK_MAIN,
    role: "assistant",
    text: "Decomposed capture into a mic stream and a transcriber. The transcriber splits again: a whisper worker for acoustics and a punctuator for sentence boundaries.",
  },
  { worktree: MOCK_MAIN, role: "tool", text: "canvas: applied 5 op(s); rev=39" },
  {
    worktree: MOCK_MAIN,
    role: "assistant",
    text: "The punctuator is failing on multi-sentence utterances; I am reading the timing data before changing the model.",
  },
  { worktree: MOCK_MAIN, role: "tool", text: "read packages/capture/asr/punctuate.ts:1-80" },
  { worktree: MOCK_SPIKE, role: "user", text: "On this branch, try it hands-free: no sentences, just calls." },
  {
    worktree: MOCK_SPIKE,
    role: "assistant",
    text: "Added voice macros beside capture and kept the transcriber; the export kit is not part of this branch.",
  },
  { worktree: MOCK_SPIKE, role: "tool", text: "write packages/capture/macros/calls.ts" },
  { worktree: MOCK_MAIN, role: "tool", text: "write packages/store/sync/merge.ts" },
  { worktree: MOCK_SPIKE, role: "tool", text: "read packages/capture/macros/calls.ts:1-60" },
];

/**
 * The agents move between bubbles; this makes that motion visible. Two cycles,
 * one per running variation, stepped together so both branches are lit at once
 * — which is what the coloured rings and the two-line "now" pill are for.
 */
const ACTIVITY_CYCLE: Record<string, readonly string[][]> = {
  [MOCK_MAIN]: [["sync-engine"], ["punctuator", "whisper-worker"], ["capture", "mic-stream"], ["taxonomy"]],
  [MOCK_SPIKE]: [["voice-macros"], ["transcriber"], ["voice-macros", "capture"], ["mic-stream"]],
};
const ACTIVITY_PERIOD_MS = 2000;

/**
 * What the main variation is "writing" while the fixture runs. The real thing
 * is the harness's own prose, folded from its text deltas; here it is one
 * sentence typed a few characters at a time so the pill can be seen doing what
 * it does with a live turn.
 */
const LIVE_SENTENCE =
  "Wiring the export kit into the notebook now — one file per trip, with the recordings beside their write-ups.";
const LIVE_PERIOD_MS = 150;

/** every variation's canvas, which is what the merged view is built out of */
function mockGraphs(): Record<string, GraphDoc> {
  return { [MOCK_MAIN]: sampleGraph(), [MOCK_SPIKE]: voiceSpikeGraph() };
}

function mockAgents(state: AgentState): Record<string, AgentState> {
  return { [MOCK_MAIN]: state, [MOCK_SPIKE]: state };
}

export function startMock(): () => void {
  const store = useApp.getState();
  if (isPlaygroundMock()) return startPlaygroundMock();

  if (isEmptyVariant()) {
    // brownfield entry: code on disk the extractor has read, nothing mapped yet
    store.ingest({
      type: "hello",
      graphs: { [MOCK_MAIN]: unmappedGraph() },
      session: mockSession(true),
      agents: mockAgents("idle"),
      recentProjects: [...MOCK_RECENTS],
      projects: mockProjects(),
      projectId: MOCK_PROJECT_ID,
      sessions: MOCK_SESSIONS.map((entry) => ({ ...entry })),
      revisions: {},
      // an unmapped project has said nothing yet, so it offers nothing yet
      nexts: {},
      autonomous: mockAutonomous(),
      tools: mockTools(),
    });
    // after `hello`, which would otherwise report a live bridge
    store.setConn("mock");
    return () => {};
  }

  if (isTrioVariant()) {
    store.ingest({
      type: "hello",
      graphs: { [MOCK_MAIN]: trioGraph() },
      session: mockSession(true),
      agents: mockAgents("idle"),
      recentProjects: [...MOCK_RECENTS],
      projects: mockProjects(),
      projectId: MOCK_PROJECT_ID,
      sessions: MOCK_SESSIONS.map((entry) => ({ ...entry })),
      revisions: { [MOCK_MAIN]: mockRevisions(7) },
      nexts: {},
      autonomous: mockAutonomous(),
      tools: mockTools(),
    });
    store.setConn("mock");
    store.ingest({ type: "activity", worktree: MOCK_MAIN, nodeIds: ["web-canvas"] });
    return () => {};
  }

  store.ingest({
    type: "hello",
    graphs: mockGraphs(),
    session: mockSession(false),
    agents: mockAgents("streaming"),
    recentProjects: [...MOCK_RECENTS],
    projects: mockProjects(),
    projectId: MOCK_PROJECT_ID,
    sessions: MOCK_SESSIONS.map((entry) => ({ ...entry })),
    revisions: { [MOCK_MAIN]: mockRevisions(41), [MOCK_SPIKE]: mockRevisions(44) },
    nexts: mockNexts(),
    autonomous: mockAutonomous(),
    tools: mockTools(),
  });
  store.setConn("mock");
  for (const line of MOCK_TRANSCRIPT) store.ingest({ type: "transcript", ...line });

  let index = 0;
  const step = (): void => {
    const state = useApp.getState();
    for (const [worktree, cycle] of Object.entries(ACTIVITY_CYCLE)) {
      const nodeIds = cycle[index % cycle.length] ?? [];
      state.ingest({ type: "activity", worktree, nodeIds: [...nodeIds] });
    }
    index += 1;
  };
  const timer = window.setInterval(step, ACTIVITY_PERIOD_MS);
  step();

  /**
   * The sentence the main variation is writing, typed out and then taken back —
   * what a real harness's text deltas do to the "now" pill, at the same pace
   * the room broadcasts them.
   */
  let typed = 0;
  const type = (): void => {
    const state = useApp.getState();
    typed += 4;
    if (typed > LIVE_SENTENCE.length + 8) {
      typed = 0;
      state.ingest({ type: "now", worktree: MOCK_MAIN, text: null });
      return;
    }
    state.ingest({ type: "now", worktree: MOCK_MAIN, text: LIVE_SENTENCE.slice(0, typed) });
  };
  const typing = window.setInterval(type, LIVE_PERIOD_MS);
  type();

  return () => {
    window.clearInterval(timer);
    window.clearInterval(typing);
  };
}

/**
 * The session_started a fixture variation comes up with. One builder because a
 * session now begins two ways — the Start card asking for it, and a sentence
 * arriving at a variation that has none — and both must land the same frame.
 */
function mockStarted(found: WorktreeInfo, backend: BackendInfo): ServerMsg {
  return {
    type: "session_started",
    worktree: found.id,
    session: { sessionId: `mock-${found.id}`, sessionName: found.branch ?? "detached", model: MOCK_MODEL },
    backend,
  };
}

/**
 * What the bridge does with an utterance or a survey aimed at a variation with
 * nothing running: it opens the harness there, broadcasts session_started, and
 * only then delivers. The fixture keeps that ordering because the canvas reads
 * the session out of the store while rendering the turn. A path the fixture has
 * never heard of fails the way the room does, with no turn appended.
 */
function mockWake(worktree: string): boolean {
  const store = useApp.getState();
  if (store.session?.sessions.some((entry) => entry.worktree === worktree) === true) return true;
  const found = MOCK_WORKTREES.find((entry) => entry.id === worktree);
  if (found === undefined) {
    store.pushError(`open_worktree failed for ${worktree}: not a variation of this fixture project`);
    return false;
  }
  store.ingest(mockStarted(found, MOCK_BACKEND));
  store.appendTranscript(
    found.id,
    "tool",
    `started ${MOCK_BACKEND.label} here to hear this (mock: no harness is really running)`,
  );
  return true;
}

export function mockSend(msg: ClientMsg): void {
  const store = useApp.getState();
  // mock mode is also how the adopt UI is verified: every outbound frame is
  // announced, because there is no socket to watch for it
  console.info(`[mock] client frame ${JSON.stringify(msg)}`);
  if (msg.type === "abort") {
    store.ingest({ type: "agent", worktree: msg.worktree, state: "idle" });
    store.appendTranscript(msg.worktree, "tool", "abort requested (mock)");
    return;
  }
  if (msg.type === "set_autonomous") {
    // the one other frame the fixture answers honestly: the bridge's own answer
    // is exactly this broadcast plus a line saying what changed
    store.ingest({ type: "autonomous", worktree: msg.worktree, on: msg.on });
    store.appendTranscript(
      msg.worktree,
      "tool",
      msg.on
        ? "autonomous mode on — it decides and keeps going until the work is finished"
        : "autonomous mode off — it stops at the end of each turn again",
    );
    return;
  }
  if (msg.type === "onboard") {
    if (!mockWake(msg.worktree)) return;
    // The same frame means two things now, and which one is decided by the
    // canvas it was sent from: with bubbles on it, nothing is refused any more
    // — the room walks the difference between the map and the code instead.
    if (useApp.getState().doc.nodes.length > 0) {
      store.appendTranscript(msg.worktree, "tool", "catch-up requested (mock: no harness is really running)");
      store.ingest({ type: "agent", worktree: msg.worktree, state: "streaming" });
      return;
    }
    store.appendTranscript(
      msg.worktree,
      "tool",
      msg.focus === undefined
        ? "onboard requested (mock: no bridge attached, so no skeleton lands)"
        : `onboard requested, focus "${msg.focus}" (mock: no bridge attached)`,
    );
    // a delivered survey is a turn: the harness starts working, which is what
    // turns the empty state into the one line worth reading while it runs
    store.ingest({ type: "agent", worktree: msg.worktree, state: "streaming" });
    return;
  }
  if (msg.type === "open_worktree") {
    // the one frame the fixture can answer honestly: a harness coming up in a
    // variation is a session_started, and the mock has a session to hand
    const found = MOCK_WORKTREES.find((entry) => entry.path === msg.path);
    if (found === undefined) {
      store.pushError(`open_worktree "${msg.path}" is not a variation of this fixture project`);
      return;
    }
    // which harness the card asked for decides where its terminal is: the one
    // the fixture launches through herdr lives in the user's own terminal, and
    // the other is Shape's own pty in the drawer
    const backend = msg.backend === "claude" ? MOCK_PANE_BACKEND : MOCK_BACKEND;
    store.ingest(mockStarted(found, backend));
    if (msg.autonomous === true) store.ingest({ type: "autonomous", worktree: found.id, on: true });
    store.appendTranscript(
      found.id,
      "tool",
      `started ${backend.label} here${msg.autonomous === true ? ", running on its own" : ""}${
        msg.remember === true ? ", remembered for this project" : ""
      } (mock: no harness is really running)`,
    );
    return;
  }
  if (msg.type === "focus_terminal") {
    // exactly what the room does with the agent's answer: a harness Shape owns
    // the pty of asks for the drawer, and one in the user's own terminal is
    // focused over there and says nothing back
    const running = useApp.getState().session?.sessions.find((entry) => entry.worktree === msg.worktree);
    if (running === undefined) {
      store.pushError(`focus_terminal: nothing is running in ${msg.worktree} (mock)`);
      return;
    }
    if (running.backend.capabilities.terminal === "pane") {
      store.ingest({ type: "terminal", worktree: msg.worktree, open: true });
      return;
    }
    store.appendTranscript(msg.worktree, "tool", "brought its own terminal window forward (mock)");
    return;
  }
  if (msg.type === "close_worktree") {
    store.ingest({ type: "session_stopped", worktree: msg.worktree, reason: "stopped from the variations menu" });
    return;
  }
  if (msg.type === "switch_project") {
    // a real bridge answers with a fresh hello; the mock has one project, so it
    // reports what it would have done instead of faking a second graph
    store.pushError(`switch_project "${msg.path}" needs the bridge — mock mode has one fixture project`);
    return;
  }
  if (msg.type === "pick_folder") {
    // the chooser is a window on the machine the agent runs on, and mock mode
    // is a fixture in a browser: there is no such machine to open it on
    store.pushError("pick_folder rejected: mock mode has no machine to choose a folder on — this needs the bridge");
    return;
  }
  if (msg.type === "create_project") {
    // same reason as a switch: creating a folder needs the bridge, so the mock
    // reports the request (publishing included) rather than faking a project
    const where = msg.github === null ? "" : `, on GitHub as ${msg.github.visibility}`;
    store.pushError(`create_project "${msg.path}"${where} needs the bridge — mock mode has one fixture project`);
    return;
  }
  if (msg.type === "discover") {
    // the fixture list is fixed, so a re-scan legitimately answers the same rows
    store.ingest({ type: "sessions", sessions: MOCK_SESSIONS.map((entry) => ({ ...entry })) });
    store.appendTranscript(MOCK_MAIN, "tool", `discover: ${MOCK_SESSIONS.length} running session(s) (mock)`);
    return;
  }
  if (msg.type === "adopt") {
    const found = MOCK_SESSIONS.find((entry) => entry.pid === msg.pid);
    if (found === undefined) {
      store.pushError(`adopt rejected: no running agent session with pid ${msg.pid} (mock)`);
      return;
    }
    // adopting is a bridge-side retarget; the mock reports the intent instead
    store.appendTranscript(MOCK_MAIN, "tool", `adopt ${found.harness} pid ${found.pid} in ${found.cwd ?? "?"} (mock)`);
    store.pushError(`adopt needs the bridge — mock mode cannot attach to ${found.harness} pid ${found.pid}`);
    return;
  }
  if (msg.type === "diff") {
    // There is no snapshot store here, so the mock fabricates a plausible answer
    // about that variation's own graph: its first bubble was reworded and
    // re-phased, its second bubble is new, its first relation is new, and one
    // bubble plus one relation that no longer exist were dropped. Enough to
    // exercise all three treatments, honest about being fiction like the rest of
    // this file.
    const doc = store.graphs[msg.worktree];
    if (doc === undefined) {
      store.pushError(`diff: this fixture has no canvas for that variation`);
      return;
    }
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

    store.ingest({
      type: "delta",
      worktree: msg.worktree,
      delta: { revA: msg.revA, revB: msg.revB, nodes, edges },
    });
    return;
  }
  // the mock has no shell: pty frames are the terminal pane's business
  if (msg.type !== "utterance") return;
  // typing into a variation with nothing running there is how a session starts
  // now: the harness comes up first, then hears the sentence
  if (!mockWake(msg.worktree)) return;
  const where = msg.referent === null ? "whole project" : `${msg.referent.kind} ${msg.referent.id}`;
  // the flag only rides on a greenfield utterance, and with no bridge attached
  // there is nothing to draw — so the mock just names the turn it would be
  const how =
    msg.productFirst === undefined ? "" : msg.productFirst ? " · product picture first" : " · straight to building";
  // anything said spends the card the last turn ended on, bridge or no bridge
  store.ingest({ type: "next", worktree: msg.worktree, next: null });
  store.appendTranscript(msg.worktree, "user", msg.text);
  store.appendTranscript(msg.worktree, "tool", `steer -> ${where}${how} (mock: no bridge attached)`);
}
