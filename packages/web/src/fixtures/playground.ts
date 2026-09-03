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
 * Nothing animates: activity pulses would make the numbers this fixture exists
 * to measure move around.
 */
import type { GraphDoc, ProjectSummary, SessionInfo } from "../../../shared/src/index.ts";
import { useApp } from "../store.ts";
import raw from "./playground.json?raw";

/** parsed per call: the caller gets a document it may freely mutate */
export function playgroundGraph(): GraphDoc {
  return JSON.parse(raw) as GraphDoc;
}

const PLAYGROUND_ROOT = "/Users/orgal/code/shape-playground";

/**
 * The project's real worktrees: `main` plus the `feature/reminders` checkout
 * that adds packages/scheduler.
 */
const PLAYGROUND_SESSION: SessionInfo = {
  sessionId: "playground-fixture",
  sessionName: "ledgerly",
  model: { provider: "anthropic", id: "claude-fable-5" },
  cwd: PLAYGROUND_ROOT,
  targetHasCode: true,
  worktrees: [
    { path: PLAYGROUND_ROOT, branch: "main", head: "6e47abb", current: true },
    {
      path: `${PLAYGROUND_ROOT}.worktrees/reminders`,
      branch: "feature/reminders",
      head: "1c4d9f2",
      current: false,
    },
  ],
  backend: {
    id: "omp",
    label: "omp",
    capabilities: { steerMidTurn: true, hostTool: true, events: "native", resume: true, terminal: "shell" },
  },
  agentConnected: true,
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

export function startPlaygroundMock(): () => void {
  const store = useApp.getState();
  store.ingest({
    type: "hello",
    graph: playgroundGraph(),
    session: { ...PLAYGROUND_SESSION, worktrees: PLAYGROUND_SESSION.worktrees.map((entry) => ({ ...entry })) },
    agent: "idle",
    recentProjects: [PLAYGROUND_ROOT],
    projects: [{ ...PLAYGROUND_PROJECT }],
    projectId: PLAYGROUND_PROJECT.projectId,
    // this fixture is about layout, not adoption: nothing to attach to
    sessions: [],
    revisions: [],
  });
  // after `hello`, which would otherwise report a live bridge
  store.setConn("mock");
  return () => {};
}
