/**
 * `?mock=playground` — the real thing, frozen.
 *
 * `playground.json` is a verbatim copy of `.shape/graph.json` from the Ledgerly
 * mock project (9 top-level bubbles, 8 children, 18 sibling relations at the
 * root, 9 extracted packages). It is the only fixture in the tree that was
 * produced by the agent rather than written by hand, which makes it the
 * regression target for layout at real scale: the 3x3 grid with 3000px looping
 * edges, and the reality band that filled half the canvas even though every
 * package was already claimed by a bubble, were both measured here.
 *
 * Its `drift` is empty, and that is the honest value: under the attribution
 * rule every reality edge in this project has a declared counterpart at some
 * altitude. The drift-glow rendering is exercised by `?mock=1` instead.
 *
 * Nothing moves: the two lit bubbles are re-announced unchanged on a slow beat,
 * which the canvas needs in order to follow the work at all, but no pulse ever
 * lands anywhere new — the numbers this fixture exists to measure stay put.
 */
import type {
  BackendInfo,
  GraphDoc,
  IntentNode,
  ProjectTools,
  RealityInfra,
  RealitySymbol,
  RealityVerification,
  SessionInfo,
  ProjectSummary,
} from "../../../shared/src/index.ts";
import { useApp } from "../store.ts";
import raw from "./playground.json?raw";

/**
 * The infra layer this project would have, added here rather than in the JSON:
 * `playground.json` stays the verbatim agent-written document it is claimed to
 * be, and these five bubbles are ours, so they live where a reader can see who
 * wrote them. `hosts` names real build ids from the file above — except on the
 * backup box, which names nothing on purpose: a piece of ground no part of the
 * project stands on is what the `hosts-nothing` mark is drawn from.
 */
const PLAYGROUND_INFRA: readonly IntentNode[] = [
  {
    id: "infra-database",
    parentId: null,
    label: "The shared database",
    summary: "Every group, expense and settlement, in one Postgres the whole team shares.",
    phase: "built",
    layer: "infra",
    kind: "database",
    codeRefs: ["infra/docker-compose.yml"],
    hosts: ["ledgerly-store", "ledgerly-api"],
  },
  {
    id: "infra-api-host",
    parentId: null,
    label: "Where the API runs",
    summary: "Two small always-on machines behind one address, redeployed on every merge.",
    phase: "built",
    layer: "infra",
    kind: "host",
    codeRefs: ["infra/fly.toml"],
    hosts: ["ledgerly-api", "ledgerly-worker"],
  },
  {
    id: "infra-reminder-queue",
    parentId: null,
    label: "The reminder queue",
    summary: "Holds nudges until the worker is ready to send them, so none is lost on a restart.",
    phase: "component",
    layer: "infra",
    kind: "queue",
    codeRefs: ["infra/docker-compose.yml"],
    hosts: ["ledgerly-queue", "ledgerly-notify"],
  },
  {
    id: "infra-pipeline",
    parentId: null,
    label: "The build-and-test pipeline",
    summary: "Runs the checks on every push and publishes the web app when they pass.",
    phase: "built",
    layer: "infra",
    kind: "ci",
    codeRefs: [".github/workflows/ci.yml"],
    hosts: ["ledgerly-web", "ledgerly-cli"],
  },
  {
    // the one piece of infrastructure nothing runs on: the dashed frame and the
    // panel's "not connected" row are both drawn from this bubble
    id: "infra-backups",
    parentId: null,
    label: "The nightly backup box",
    summary: "Copies the database somewhere else every night and keeps a month of copies.",
    phase: "built",
    layer: "infra",
    kind: "host",
    codeRefs: ["infra/backups.tf"],
    hosts: [],
  },
];

/**
 * What the extractor would have read out of the configuration. Three of these
 * are claimed by the bubbles above; the CDN is not, which is the one ghost the
 * infra layer draws.
 */
const PLAYGROUND_REALITY_INFRA: readonly RealityInfra[] = [
  {
    id: "i:postgres",
    label: "Postgres 16",
    kind: "database",
    evidence: ["infra/docker-compose.yml"],
    hint: "a Postgres database from infra/docker-compose.yml",
  },
  {
    id: "i:fly",
    label: "fly.io app “ledgerly-api”",
    kind: "host",
    evidence: ["infra/fly.toml"],
    hint: "a fly.io app read out of infra/fly.toml",
  },
  {
    id: "i:redis",
    label: "Redis 7",
    kind: "queue",
    evidence: ["infra/docker-compose.yml"],
    hint: "a Redis service from infra/docker-compose.yml",
  },
  {
    id: "i:cdn",
    label: "Cloudflare CDN",
    kind: "cdn",
    evidence: ["infra/terraform/cdn.tf"],
    hint: "an edge cache declared in Terraform that no bubble accounts for",
  },
];

/** the mechanical inside of one leaf: the scratch store's own module */
const PLAYGROUND_SYMBOLS: readonly RealitySymbol[] = [
  {
    id: "s:packages/store/src/memory-store.ts#MemoryStore",
    file: "packages/store/src/memory-store.ts",
    name: "MemoryStore",
    kind: "class",
    exported: true,
    line: 14,
    pkg: "r:store",
  },
  {
    id: "s:packages/store/src/memory-store.ts#createMemoryStore",
    file: "packages/store/src/memory-store.ts",
    name: "createMemoryStore",
    kind: "function",
    exported: true,
    line: 96,
    pkg: "r:store",
  },
  {
    id: "s:packages/store/src/memory-store.ts#cloneRecord",
    file: "packages/store/src/memory-store.ts",
    name: "cloneRecord",
    kind: "function",
    exported: false,
    line: 132,
    pkg: "r:store",
  },
];

/**
 * The correctness layer this project would have, added here for the same reason
 * the infra layer is: `playground.json` stays the verbatim agent-written
 * document, and these five bubbles are ours. `verifies` names real build ids
 * from the file above — and the parts it does NOT name are what leaves a hollow
 * shield on the canvas. The load test names none at all, which is the other
 * end of the same silence: a check nobody said what it checks.
 */
const PLAYGROUND_CORRECTNESS: readonly IntentNode[] = [
  {
    id: "verify-domain-tests",
    parentId: null,
    label: "The money and split tests",
    summary: "Every way a bill can be divided, checked against worked examples down to the cent.",
    phase: "built",
    layer: "correctness",
    kind: "test",
    codeRefs: ["packages/domain/test"],
    verifies: ["ledgerly-domain"],
  },
  {
    id: "verify-api-smoke",
    parentId: null,
    label: "The API smoke run",
    summary: "Starts the service, creates a group, files an expense, and reads the balance back.",
    phase: "built",
    layer: "correctness",
    kind: "smoke",
    codeRefs: ["scripts/smoke-api.sh"],
    verifies: ["ledgerly-api"],
  },
  {
    id: "verify-push-checks",
    parentId: null,
    label: "Checks run on every push",
    summary: "Types and lint over the whole workspace before anything is allowed to merge.",
    phase: "built",
    layer: "correctness",
    kind: "check",
    codeRefs: [".github/workflows/ci.yml"],
    verifies: ["ledgerly-store"],
  },
  {
    id: "verify-uptime",
    parentId: null,
    label: "The uptime watch",
    summary: "Pings the service every minute and shouts if two pings in a row fail.",
    phase: "component",
    layer: "correctness",
    kind: "monitor",
    codeRefs: ["infra/grafana"],
    verifies: ["ledgerly-api"],
  },
  {
    // the one check that attests nothing: somebody wrote the run down and never
    // said which part it keeps honest
    id: "verify-load-test",
    parentId: null,
    label: "The Friday load test",
    summary: "Drives a thousand made-up groups through the service and watches what slows down.",
    phase: "built",
    layer: "correctness",
    kind: "test",
    codeRefs: ["scripts/load-test.ts"],
    verifies: [],
  },
];

/**
 * What the extractor would have found in the code. Three of these are claimed
 * by the bubbles above; the manual QA pass is not, which is the one ghost the
 * correctness layer draws.
 */
const PLAYGROUND_REALITY_VERIFICATION: readonly RealityVerification[] = [
  {
    id: "v:domain-tests",
    label: "Tests in packages/domain (9 files)",
    kind: "test",
    evidence: ["packages/domain/test/split.test.ts", "vitest.config.ts"],
    hint: "9 test files under packages/domain, run by vitest",
    covers: ["packages/domain"],
  },
  {
    id: "v:api-smoke",
    label: "Smoke checks: smoke-api",
    kind: "smoke",
    evidence: ["scripts/smoke-api.sh"],
    hint: "a script that drives the running service end to end",
    covers: ["apps/api"],
  },
  {
    id: "v:push-checks",
    label: "Static checks: typecheck, lint",
    kind: "check",
    evidence: [".github/workflows/ci.yml"],
    hint: "types and lint over the whole workspace on every push",
    covers: ["packages/store", "packages/config", "apps/web"],
  },
  {
    id: "v:qa-pass",
    label: "The release QA pass",
    kind: "review",
    evidence: ["docs/qa-pass.md"],
    hint: "a walkthrough somebody does by hand that no bubble accounts for",
    covers: ["apps/web"],
  },
];

/**
 * Parsed per call: the caller gets a document it may freely mutate. The infra
 * layer, the correctness layer and everything the extractor would have read are
 * grafted on here — the JSON predates all of them, exactly like a graph written
 * by an older agent, which is the case the parser's defaults exist for.
 *
 * The build side needs no graft to show its own silence: `ledgerly-config` in
 * the JSON is finished, no capability realizes it and no infrastructure runs
 * it, so it carries both build-side marks at once. `ledgerly-domain` is the
 * subtler case — its two children are realized, it is not.
 */
export function playgroundGraph(): GraphDoc {
  const doc = JSON.parse(raw) as GraphDoc;
  return {
    ...doc,
    nodes: [
      ...doc.nodes,
      ...PLAYGROUND_INFRA.map((node) => ({ ...node, hosts: [...(node.hosts ?? [])] })),
      ...PLAYGROUND_CORRECTNESS.map((node) => ({ ...node, verifies: [...(node.verifies ?? [])] })),
    ],
    reality: {
      ...doc.reality,
      symbols: PLAYGROUND_SYMBOLS.map((symbol) => ({ ...symbol })),
      infra: PLAYGROUND_REALITY_INFRA.map((item) => ({ ...item, evidence: [...item.evidence] })),
      verification: PLAYGROUND_REALITY_VERIFICATION.map((item) => ({
        ...item,
        evidence: [...item.evidence],
        covers: [...item.covers],
      })),
    },
  };
}

const PLAYGROUND_ROOT = "/Users/orgal/code/shape-playground";

const PLAYGROUND_REMINDERS = `${PLAYGROUND_ROOT}.worktrees/reminders`;

/**
 * The same project on `feature/reminders`: it has a scheduler nothing on `main`
 * has, and its notifier is mid-rework rather than finished. Everything else is
 * the same document — which is the case the merge, the pips and the side
 * panel's "where" section exist for.
 */
function remindersGraph(): GraphDoc {
  const doc = playgroundGraph();
  const nodes = doc.nodes.map((node) =>
    node.id === "ledgerly-notify"
      ? {
          ...node,
          phase: "building" as const,
          status: "Moving the nudges onto the scheduler; email path is done.",
        }
      : node,
  );
  nodes.push({
    id: "ledgerly-scheduler",
    parentId: null,
    label: "Scheduler",
    summary: "Decides when a nudge is due and hands it to the notifier at that moment.",
    phase: "building",
    status: "Cron parsing is in; the retry window is not.",
    kind: "service",
    codeRefs: ["packages/scheduler"],
  });
  return {
    ...doc,
    rev: doc.rev + 3,
    nodes,
    edges: [
      ...doc.edges,
      {
        id: "ledgerly-scheduler--ledgerly-notify",
        source: "ledgerly-scheduler",
        target: "ledgerly-notify",
        kind: "dataflow",
        label: "nudges that are due",
      },
    ],
  };
}

const PLAYGROUND_BACKEND: BackendInfo = {
  id: "omp",
  label: "omp",
  capabilities: { steerMidTurn: false, hostTool: true, events: "native", resume: false, terminal: "external" },
};

/** what the playground machine has: herdr, and the omp session reporting in through it */
const PLAYGROUND_TOOLS: ProjectTools = {
  launcher: "herdr",
  launchers: [{ id: "herdr", label: "herdr", path: "/usr/local/bin/herdr", version: "0.9.2" }],
  harnesses: [{ id: "omp", label: "omp", path: "/usr/local/bin/omp", version: "2.1.0" }],
};

const PLAYGROUND_MODEL = { provider: "anthropic", id: "claude-fable-5" };

/**
 * The project's real worktrees: `main` plus the `feature/reminders` checkout
 * that adds packages/scheduler. Both have a harness reporting in, because the
 * merged canvas, the variations pill and the two-line "now" pill are only true
 * to life with work happening in two variations at once.
 */
const PLAYGROUND_SESSION: SessionInfo = {
  cwd: PLAYGROUND_ROOT,
  targetHasCode: true,
  worktrees: [
    { id: PLAYGROUND_ROOT, path: PLAYGROUND_ROOT, branch: "main", head: "6e47abb" },
    { id: PLAYGROUND_REMINDERS, path: PLAYGROUND_REMINDERS, branch: "feature/reminders", head: "1c4d9f2" },
  ],
  sessions: [
    {
      worktree: PLAYGROUND_ROOT,
      session: { sessionId: "playground-fixture", sessionName: "ledgerly", model: PLAYGROUND_MODEL },
      backend: PLAYGROUND_BACKEND,
      state: "streaming",
    },
    {
      worktree: PLAYGROUND_REMINDERS,
      session: { sessionId: "playground-reminders", sessionName: "ledgerly reminders", model: PLAYGROUND_MODEL },
      backend: PLAYGROUND_BACKEND,
      state: "streaming",
    },
  ],
  agentConnected: true,
  directivePath: null,
  // this fixture runs on herdr, so it carries the manager the bridge would have
  // opened there — the header pill's populated state is reachable in the playground
  manager: {
    paneId: "pane-7",
    tabId: "tab-3",
    workspaceId: "ws-ledgerly",
    agentName: "manager",
    origin: "opened",
    shapeAware: true,
  },
};

/** one project, named by the same id `hello` reports joined */
const PLAYGROUND_PROJECT: ProjectSummary = {
  projectId: "playground-fixture:/Users/orgal/code/shape-playground",
  label: "shape-playground",
  cwd: PLAYGROUND_ROOT,
  harness: "omp",
  agentConnected: true,
  lastSeen: "2026-02-11T09:14:00.000Z",
};

export function isPlaygroundMock(): boolean {
  return new URLSearchParams(window.location.search).get("mock") === "playground";
}

/**
 * How often the fixture re-announces where the two variations are working. Slow
 * on purpose: it is a heartbeat for the view-follow rule, not an animation.
 */
const ACTIVITY_BEAT_MS = 1500;

export function startPlaygroundMock(): () => void {
  const store = useApp.getState();
  store.ingest({
    type: "hello",
    graphs: { [PLAYGROUND_ROOT]: playgroundGraph(), [PLAYGROUND_REMINDERS]: remindersGraph() },
    session: { ...PLAYGROUND_SESSION, worktrees: PLAYGROUND_SESSION.worktrees.map((entry) => ({ ...entry })) },
    agents: { [PLAYGROUND_ROOT]: "streaming", [PLAYGROUND_REMINDERS]: "streaming" },
    recentProjects: [PLAYGROUND_ROOT],
    projects: [{ ...PLAYGROUND_PROJECT }],
    projectId: PLAYGROUND_PROJECT.projectId,
    // this fixture is about layout, not adoption: nothing to attach to
    sessions: [],
    revisions: {},
    tools: PLAYGROUND_TOOLS,
  });
  // after `hello`, which would otherwise report a live bridge
  store.setConn("mock");
  // One line per variation and one lit bubble each — the same two bubbles on
  // every beat, so nothing moves between frames: this fixture measures layout.
  // The beat itself is the point of a beat at all: the canvas follows the work,
  // so re-announcing the same build-layer activity is how a reader standing in
  // the product view sees the view arrive at build, and how a switch made by
  // hand is seen to hold. The first beat is one interval late, so the layer the
  // project opens on is on screen before anything follows anywhere.
  const beat = (): void => {
    const state = useApp.getState();
    state.ingest({ type: "activity", worktree: PLAYGROUND_ROOT, nodeIds: ["ledgerly-api"] });
    state.ingest({ type: "activity", worktree: PLAYGROUND_REMINDERS, nodeIds: ["ledgerly-notify"] });
  };
  store.ingest({ type: "transcript", worktree: PLAYGROUND_ROOT, role: "tool", text: "read apps/api/src/routes.ts" });
  store.ingest({
    type: "transcript",
    worktree: PLAYGROUND_REMINDERS,
    role: "tool",
    text: "write packages/scheduler/src/cron.ts",
  });
  const timer = window.setInterval(beat, ACTIVITY_BEAT_MS);
  return () => window.clearInterval(timer);
}
