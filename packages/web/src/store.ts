import { create } from "zustand";
import {
  emptyGraph,
  layerOf,
  type AgentSession,
  type AgentState,
  type BackendInfo,
  type DiscoveredSession,
  type GraphDelta,
  type GraphDoc,
  type Layer,
  type Next,
  type ProjectSummary,
  type ProjectTools,
  type Referent,
  type RevisionInfo,
  type ServerMsg,
  type SessionInfo,
  type WorktreeInfo,
  type WorktreeSession,
} from "../../shared/src/index.ts";
import type { PtyServerMsg } from "../../shared/src/pty.ts";
import {
  coveredByIdOf,
  coveredByPartOf,
  hostsIdOf,
  hostsInfraOf,
  isCoveredById,
  isHostsId,
  isMoreId,
  isRealizesId,
  isVerifiesId,
  mergeGraphs,
  moreBaseOf,
  realizesIdOf,
  realizesProductOf,
  selectGhosts,
  verifiesIdOf,
  verifiesVerifyOf,
  type WhereMark,
} from "./layer.ts";

/**
 * What the bridge's shell is doing, for ONE variation. Terminal *output* is
 * deliberately absent: a shell printing a thousand lines must not re-render the
 * app, so bytes go straight to the xterm instance through `setPtySink` instead
 * of state.
 */
export interface PtyView {
  /** the bridge has a live shell right now */
  open: boolean;
  shell: string;
  cwd: string;
  /** set when the shell exited on its own; cleared when one starts again */
  exited: { code: number | null } | null;
}

/** a variation with no terminal at all; a stable object, so selectors may return it */
export const NO_PTY: PtyView = { open: false, shell: "", cwd: "", exited: null };

type PtySink = (data: string) => void;

/** one terminal per page, so one sink; null while nothing is drawing */
let ptySink: PtySink | null = null;

export function setPtySink(sink: PtySink | null): void {
  ptySink = sink;
}

export type ConnStatus = "connecting" | "live" | "lost" | "mock";

export type TranscriptRole = "assistant" | "user" | "tool";

export interface TranscriptEntry {
  seq: number;
  /** which variation's harness said this */
  worktree: string;
  role: TranscriptRole;
  text: string;
}

export interface ErrorToast {
  seq: number;
  message: string;
}

/** transcript is a stream; keep the tail bounded */
const TRANSCRIPT_CAP = 500;
const ERROR_TTL_MS = 9000;
/** the "opened in your terminal" line: seen, read, gone */
const NOTICE_TTL_MS = 2000;

/** monotonic key source for transcript entries and error toasts */
let keySeq = 0;

/**
 * Monotonic tick stamped on each variation whenever it lights bubbles. Which
 * variation is the steering target falls back to "the one that worked on this
 * bubble last", and that needs an order across variations, not a timestamp per
 * frame.
 */
let activityTick = 0;

/**
 * Stable empty snapshots. A zustand selector must never mint a fresh array,
 * object or Set: `useSyncExternalStore` compares snapshots by identity, so
 * `?? []` reads as "changed" on every store read and re-renders forever — which
 * unmounted the whole app on any load where `session` was still null, i.e.
 * every real connection before the first hello. Exported because every
 * component that reads a list off `session` needs the same one.
 */
const NO_ACTIVE: ReadonlySet<string> = new Set<string>();
const NO_REVISIONS: RevisionInfo[] = [];
const NO_WHERE_MARKS: readonly WhereMark[] = [];
export const NO_WORKTREES: WorktreeInfo[] = [];
export const NO_RUNNING: WorktreeSession[] = [];

/** where the filter of a project is remembered between visits */
function filterKey(projectId: string): string {
  return `shape.variations.${projectId}`;
}

/**
 * The filter is a reading preference, not project state: it belongs to this
 * browser and to this project, and a reload that forgot it would silently put
 * three variations back on a canvas somebody narrowed to one. A stored id that
 * no longer names a worktree is dropped; nothing left means "all", which is
 * also what an unreadable store means.
 */
function loadFilter(projectId: string, worktrees: readonly WorktreeInfo[]): ReadonlySet<string> | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(filterKey(projectId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  let ids: unknown;
  try {
    ids = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(ids)) return null;
  const known = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && worktrees.some((entry) => entry.id === id)) known.add(id);
  }
  if (known.size === 0 || known.size === worktrees.length) return null;
  return known;
}

function saveFilter(projectId: string | null, filter: ReadonlySet<string> | null): void {
  if (projectId === null) return;
  try {
    if (filter === null) window.localStorage.removeItem(filterKey(projectId));
    else window.localStorage.setItem(filterKey(projectId), JSON.stringify([...filter]));
  } catch {
    // a browser that refuses storage still gets the filter, just not next time
  }
}

/** colour order is id order, so a variation keeps its colour as others come and go */
function sortedIds(worktrees: readonly WorktreeInfo[]): string[] {
  return worktrees.map((entry) => entry.id).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * The main worktree: the one whose path is the project's own directory. It owns
 * the git common dir, so its canvas is the primary copy of every bubble.
 */
export function mainWorktreeOf(session: SessionInfo | null): string | null {
  if (session === null) return null;
  const main = session.worktrees.find((entry) => entry.path === session.cwd);
  return main?.id ?? session.worktrees[0]?.id ?? null;
}

/** what a person calls a variation: its branch, or the folder when it has none */
export function branchOf(worktrees: readonly WorktreeInfo[], id: string): string {
  const found = worktrees.find((entry) => entry.id === id);
  if (found === undefined) return id;
  if (found.branch !== null) return found.branch;
  const trimmed = found.path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * How many colour slots variations cycle through (`--wt-0…5` in the
 * stylesheet). A repo with more open worktrees than that reuses a colour rather
 * than inventing an unreadable one; the pip's tooltip still names the branch.
 */
export const VARIATION_TONES = 6;

/** the colour slot of one variation: its place in id order, which never moves */
export function toneOf(worktreeIds: readonly string[], id: string): number {
  const at = worktreeIds.indexOf(id);
  return at === -1 ? 0 : at % VARIATION_TONES;
}

/** a harness is running in this variation right now, so it can be steered */
export function runsIn(session: SessionInfo | null, worktree: string | null): boolean {
  if (session === null || worktree === null) return false;
  return session.sessions.some((entry) => entry.worktree === worktree);
}

/** the union of what the filtered variations are working on: what the canvas lights */
function activeUnion(
  activity: Record<string, ReadonlySet<string>>,
  filter: ReadonlySet<string> | null,
): ReadonlySet<string> {
  const all = new Set<string>();
  for (const [worktree, ids] of Object.entries(activity)) {
    if (filter !== null && !filter.has(worktree)) continue;
    for (const id of ids) all.add(id);
  }
  return all.size === 0 ? NO_ACTIVE : all;
}

export interface AppState {
  /** every variation's canvas, keyed by worktree id */
  graphs: Record<string, GraphDoc>;
  /**
   * The merged reading of the filtered variations — one document, so every
   * selector, layout pass and panel in the app is written against a graph
   * rather than against a list of graphs. See `mergeGraphs`.
   */
  doc: GraphDoc;
  /** per merged bubble, which variations hold it and where it says something else */
  where: Record<string, readonly WhereMark[]>;
  session: SessionInfo | null;
  /**
   * What is installed where this project's agent runs: which launcher it will
   * use, and every coding agent it found. The start-a-session card is built
   * from it, so a machine with nothing installed can say so plainly.
   */
  tools: ProjectTools | null;
  /** every variation's id in colour order (id order), so a colour is stable */
  worktreeIds: readonly string[];
  /** what each variation's harness is doing; a variation with no harness is idle */
  agents: Record<string, AgentState>;
  /** intent node ids each variation is working inside right now */
  activity: Record<string, ReadonlySet<string>>;
  /** the union over the filtered variations: what the canvas lights */
  activeNodes: ReadonlySet<string>;
  /** when each variation last lit a bubble, as a tick — the target fallback reads it */
  activeAt: Record<string, number>;
  transcript: TranscriptEntry[];
  /**
   * The sentence each variation's harness is writing this second, as it is
   * written. Never stored anywhere else: it is a feeling of liveness, not a
   * record, and the transcript keeps the finished text.
   */
  now: Record<string, string | null>;
  selection: Referent | null;
  /**
   * The bubble or drawn line the pointer is over. Edge labels are hidden until
   * something asks for them, so this is what un-hides them; it is deliberately
   * not part of the selection, which survives the pointer leaving.
   */
  hover: HoverTarget | null;
  conn: ConnStatus;
  errors: ErrorToast[];
  showReality: boolean;
  /**
   * Where each variation's last turn left things: the card under the canvas,
   * per worktree. Ephemeral like the transcript — it belongs to the turn that
   * produced it, and the bridge takes it back the moment anything is said.
   */
  nexts: Record<string, Next | null>;
  /** which variations are deciding for themselves and carrying on unattended */
  autonomous: Record<string, boolean>;
  /**
   * Which layer of the project is on the canvas: the capabilities it promises a
   * person, the parts that build them, or where those parts run. One canvas,
   * three readings — never two at once, because a capability, a package and a
   * database are not peers.
   */
  view: Layer;
  /**
   * When the reader last put the canvas on a layer by hand, in epoch
   * milliseconds; 0 means never. The canvas otherwise follows the work — a
   * variation reporting that it is busy in one layer brings that layer up — and
   * this is what stops it from overruling somebody who just chose a layer.
   */
  viewPinnedAt: number;
  /** the drilled-into bubble, fold or realizes drill; null is the layer's root */
  focus: string | null;
  /**
   * Where the other views were left. Reading a layer is a place you stand, so
   * switching away and back returns you to it rather than to its root — and
   * arriving in one from another (a "built by" or "runs N parts" drill) is what
   * parks the bubble you came from as the selection to come back to.
   */
  parked: Record<Layer, ViewPlace>;
  /** project paths offered by the bridge in `hello`, most recent first */
  recentProjects: string[];
  /**
   * Every project this server hosts, newest-seen first — the picker's list.
   * One entry in local mode; more once several agents attach to one server.
   */
  projects: ProjectSummary[];
  /** which of `projects` this socket is joined to; null until the first hello */
  projectId: string | null;
  /**
   * The answer to one native-chooser request, one-shot: `path` is the folder to
   * open, or null when the person closed the chooser. `seq` rises with every
   * answer, so choosing the same folder twice still reads as two answers — and
   * so a cancel, which opens nothing, still tells the button asking to stop
   * saying "picking…". A cancel produces no `error` frame, so this is the only
   * signal it leaves.
   */
  pickedFolder: { path: string | null; seq: number } | null;
  /**
   * Agent sessions running on this machine, newest first — the adopt list. The
   * bridge refreshes it on every hello and on demand (`discover`).
   */
  sessions: DiscoveredSession[];
  /** saved versions of each variation's canvas, oldest first */
  revisions: Record<string, RevisionInfo[]>;
  /**
   * Which variations are on the canvas, or null for all of them — the default,
   * and what the variations pill switches. Persisted per project.
   */
  filter: ReadonlySet<string> | null;
  /**
   * The variation the reader pinned as the steering target, or null to let the
   * default rule pick one (`selectTarget`). Pinning is explicit: a target that
   * moved on its own while somebody was dictating would send their sentence to
   * a branch they were not looking at.
   */
  target: string | null;
  /** the pair a comparison was asked about, and which variation's history it is in */
  compare: { worktree: string; revA: number; revB: number } | null;
  /** the answer on screen; null means the canvas is showing the project as it is now */
  delta: GraphDelta | null;
  /**
   * That variation's graph as it stood when the answer landed, kept only when
   * it IS the after side of the comparison. Frozen on purpose: a `graph` frame
   * arriving later must not quietly rewrite what a comparison claims, and a
   * graph that has moved past `revB` is no longer evidence about `revB`.
   */
  deltaContext: GraphDoc | null;

  /** the terminal drawer is on screen, over the bottom of the canvas */
  terminalOpen: boolean;
  /**
   * A passing line at the top of the stage — "opened in your terminal" when a
   * harness in the user's own terminal was brought forward, and nothing else
   * happened on this screen to prove the click landed. Errors have their own,
   * louder card; this one goes away on its own.
   */
  notice: { seq: number; text: string } | null;
  /** one terminal per variation; the pane shows the target's */
  ptys: Record<string, PtyView>;

  /**
   * Whether the next first utterance on an empty canvas buys a product picture
   * before any building. Local until it is sent: it rides on the utterance, so
   * the bridge never has to remember a preference.
   */
  productFirst: boolean;

  /** single funnel for everything arriving from the bridge */
  ingest: (msg: ServerMsg) => void;
  /** terminal frames have their own wire; they never touch the graph */
  applyPty: (msg: PtyServerMsg) => void;
  /** show or hide the terminal drawer; the server asks for the showing */
  setTerminal: (open: boolean) => void;
  /** say one passing line at the top of the stage; it clears itself */
  notify: (text: string) => void;
  setConn: (conn: ConnStatus) => void;
  select: (referent: Referent | null) => void;
  /** what the pointer is over, which is what reveals a stroke's words */
  setHover: (target: HoverTarget | null) => void;
  toggleReality: () => void;
  setProductFirst: (on: boolean) => void;
  setFocus: (nodeId: string | null) => void;
  /** which variations the canvas merges; null is all of them */
  setFilter: (ids: ReadonlySet<string> | null) => void;
  /** pin the variation utterances go to, or null to let the default rule pick */
  setTarget: (worktree: string | null) => void;
  /** switch layers, restoring where that layer was last left */
  setView: (view: Layer) => void;
  /** product → build: show exactly the bubbles that make one capability real */
  drillRealizers: (productId: string) => void;
  /** infra → build: show exactly the parts that run on one piece of infrastructure */
  drillHosts: (infraId: string) => void;
  /** correctness → build: show exactly the parts one verification attests */
  drillVerified: (verifyId: string) => void;
  /** build → correctness: show exactly the checks that cover one part */
  drillCovering: (buildId: string) => void;
  /**
   * Put one bubble on screen wherever it lives: the layer it belongs to, the
   * altitude that shows it, selected. This is what following a cross-layer chip
   * does, in either direction.
   */
  revealNode: (nodeId: string) => void;
  beginCompare: (worktree: string, revA: number, revB: number) => void;
  exitCompare: () => void;
  appendTranscript: (worktree: string, role: TranscriptRole, text: string) => void;
  pushError: (message: string) => void;
  dismissError: (seq: number) => void;
}

/**
 * What the pointer is over. Not a `Referent`: an `edge` here is a *drawn* line,
 * whose id is a render id and may stand for several relations, so it addresses
 * the canvas rather than the document.
 */
export interface HoverTarget {
  kind: "node" | "edge";
  id: string;
}

/** where a view was left: the layer it was drilled into, and what was selected there */
export interface ViewPlace {
  focus: string | null;
  selection: Referent | null;
}

const NOWHERE: ViewPlace = { focus: null, selection: null };

/**
 * A focus only survives while the thing it names can still exist. Five of the
 * six kinds are synthetic — never in the document — so what has to still be
 * there is the bubble whose layer folded, the capability a realizes drill asks
 * about, the infrastructure a hosts drill asks about, the verification a
 * verifies drill asks about, the part a covered-by drill asks about, or nothing
 * at all for a root layer.
 */
function keepFocus(focus: string | null, doc: GraphDoc): string | null {
  if (focus === null) return null;
  const product = realizesProductOf(focus);
  if (product !== null) return doc.nodes.some((node) => node.id === product) ? focus : null;
  const infra = hostsInfraOf(focus);
  if (infra !== null) return doc.nodes.some((node) => node.id === infra) ? focus : null;
  const verify = verifiesVerifyOf(focus);
  if (verify !== null) return doc.nodes.some((node) => node.id === verify) ? focus : null;
  const covered = coveredByPartOf(focus);
  if (covered !== null) return doc.nodes.some((node) => node.id === covered) ? focus : null;
  if (isMoreId(focus)) {
    const base = moreBaseOf(focus);
    return base === null || doc.nodes.some((node) => node.id === base) ? focus : null;
  }
  return doc.nodes.some((node) => node.id === focus) ? focus : null;
}

/** a selection only survives while its target still exists in the graph */
function keepSelection(selection: Referent | null, doc: GraphDoc): Referent | null {
  if (selection === null) return null;
  // the fold carries no referent, but it is still the highlighted bubble
  if (selection.kind === "node" && isMoreId(selection.id)) {
    return keepFocus(selection.id, doc) === null ? null : selection;
  }
  const pool = selection.kind === "node" ? doc.nodes : doc.edges;
  for (const item of pool) {
    if (item.id === selection.id) return selection;
  }
  return null;
}

/**
 * What the merge and the places standing on it look like after a variation's
 * graph, or the filter, changed. The canvas is one document, so a variation
 * arriving or leaving the filter can delete the bubble somebody had selected or
 * drilled into exactly as an agent deleting it can — and it is answered the
 * same way.
 */
function remerged(state: AppState, graphs: Record<string, GraphDoc>, filter: ReadonlySet<string> | null) {
  const { doc, where } = mergeGraphs({ graphs, filter, main: mainWorktreeOf(state.session) });
  return {
    graphs,
    filter,
    doc,
    where,
    activeNodes: activeUnion(state.activity, filter),
    selection: keepSelection(state.selection, doc),
    focus: keepFocus(state.focus, doc),
    parked: {
      product: {
        focus: keepFocus(state.parked.product.focus, doc),
        selection: keepSelection(state.parked.product.selection, doc),
      },
      build: {
        focus: keepFocus(state.parked.build.focus, doc),
        selection: keepSelection(state.parked.build.selection, doc),
      },
      infra: {
        focus: keepFocus(state.parked.infra.focus, doc),
        selection: keepSelection(state.parked.infra.selection, doc),
      },
      correctness: {
        focus: keepFocus(state.parked.correctness.focus, doc),
        selection: keepSelection(state.parked.correctness.selection, doc),
      },
    },
    // the pointer's target is about the frame that was on screen
    hover: null,
  };
}

/** the session record with one variation's harness added or replaced */
function withSession(
  session: SessionInfo | null,
  worktree: string,
  running: { session: AgentSession; backend: BackendInfo; state: AgentState },
): SessionInfo | null {
  if (session === null) return null;
  const entry: WorktreeSession = { worktree, ...running };
  const others = session.sessions.filter((item) => item.worktree !== worktree);
  return { ...session, sessions: [...others, entry] };
}

/**
 * Where a switch of layers lands. Both a click on the layer tabs and the canvas
 * following the work go through this, so a layer arrived at on its own is the
 * same place it would have been arrived at by hand: the layer's parked focus and
 * selection, with the layer being left parked to come back to.
 */
function switched(state: AppState, view: Layer): Partial<AppState> {
  // A cross-layer drill is a question about a bubble in another layer, not a
  // place in this one.
  const detour =
    state.focus !== null &&
    (isRealizesId(state.focus) ||
      isHostsId(state.focus) ||
      isVerifiesId(state.focus) ||
      isCoveredById(state.focus));
  // Asking for the layer you are already in, while the canvas is answering a
  // question about another one, means "just show me this layer" — so the drill
  // is what gets dropped. Without this the build root is unreachable from a
  // "built by", "running on", "attested by" or "covers" layer without walking
  // through a bubble.
  if (view === state.view) return detour ? { focus: null, hover: null } : {};
  // leaving a drill parks the layer's own root, so toggling back lands on the
  // build view's real home rather than back inside the detour
  const here: ViewPlace = detour
    ? { focus: null, selection: null }
    : { focus: state.focus, selection: state.selection };
  const there = state.parked[view];
  return {
    view,
    focus: there.focus,
    selection: there.selection,
    parked: { ...state.parked, [state.view]: here },
    hover: null,
  };
}

/** how long a layer chosen by hand keeps the canvas, no matter what arrives */
const VIEW_PIN_MS = 20_000;

/**
 * The one layer a piece of work is happening on, or null when it is spread over
 * several of them or names nothing this variation's canvas has. Work in two
 * layers at once is not a place to send a reader.
 */
function workingLayer(doc: GraphDoc | undefined, nodeIds: readonly string[]): Layer | null {
  if (doc === undefined) return null;
  let only: Layer | null = null;
  for (const id of nodeIds) {
    const node = doc.nodes.find((entry) => entry.id === id);
    if (node === undefined) continue;
    const layer = layerOf(node);
    if (only === null) only = layer;
    else if (only !== layer) return null;
  }
  return only;
}

/**
 * The canvas following the work: when a variation on screen reports that it is
 * busy inside ONE layer, that layer is what the reader wants to be looking at,
 * so it comes up on its own. Designing a product and then building it is the
 * case this exists for — nobody should have to click "build" to watch the thing
 * they just asked for get built — and it reads the same for infrastructure and
 * for what proves the parts correct.
 *
 * Three things say no. A layer chosen by hand in the last twenty seconds is the
 * reader's answer to this question and outranks it. A comparison is flat and
 * belongs to no layer at all. And a variation nobody is looking at (outside the
 * filter) does not get to redirect the ones they are.
 *
 * Returns null when nothing should move.
 */
function following(state: AppState, worktree: string, nodeIds: readonly string[]): Partial<AppState> | null {
  if (nodeIds.length === 0 || state.delta !== null) return null;
  if (state.filter !== null && !state.filter.has(worktree)) return null;
  if (state.viewPinnedAt !== 0 && Date.now() - state.viewPinnedAt < VIEW_PIN_MS) return null;
  const layer = workingLayer(state.graphs[worktree], nodeIds);
  if (layer === null || layer === state.view) return null;
  return switched(state, layer);
}

export const useApp = create<AppState>((set, get) => ({
  graphs: {},
  doc: emptyGraph(),
  where: {},
  session: null,
  tools: null,
  worktreeIds: [],
  agents: {},
  activity: {},
  activeNodes: NO_ACTIVE,
  activeAt: {},
  transcript: [],
  now: {},
  selection: null,
  hover: null,
  conn: "connecting",
  errors: [],
  showReality: true,
  nexts: {},
  autonomous: {},
  view: "build",
  viewPinnedAt: 0,
  focus: null,
  parked: { product: NOWHERE, build: NOWHERE, infra: NOWHERE, correctness: NOWHERE },
  recentProjects: [],
  projects: [],
  projectId: null,
  pickedFolder: null,
  sessions: [],
  revisions: {},
  filter: null,
  target: null,
  compare: null,
  delta: null,
  deltaContext: null,
  terminalOpen: false,
  notice: null,
  ptys: {},
  productFirst: true,

  ingest: (msg) => {
    switch (msg.type) {
      case "hello": {
        const filter = loadFilter(msg.projectId, msg.session.worktrees);
        const { doc, where } = mergeGraphs({
          graphs: msg.graphs,
          filter,
          main: mainWorktreeOf(msg.session),
        });
        // A canvas with capabilities on it leads with them: what the project
        // promises a person is the reading that makes its parts make sense. A
        // project with none is a build-only project and opens as one. Neither
        // the infra nor the correctness layer is ever opened into: they answer
        // "where does this run" and "what proves it works", which are questions
        // about parts a reader has not met yet.
        const view: Layer = doc.nodes.some((node) => layerOf(node) === "product") ? "product" : "build";
        // `hello` also arrives after a successful switch_project, so everything
        // scoped to a session is dropped here. Carrying a selection, a focus or
        // a transcript across projects would attribute one project's work to
        // another — worse than losing scroll position.
        set({
          graphs: msg.graphs,
          doc,
          where,
          session: msg.session,
          tools: msg.tools,
          worktreeIds: sortedIds(msg.session.worktrees),
          recentProjects: msg.recentProjects,
          projects: msg.projects,
          projectId: msg.projectId,
          // the chooser's answer is spent by the switch this hello answers: a
          // pick is read the moment it lands, one task before the socket
          // carries the new project back, so clearing it here drops a spent
          // one-shot rather than swallowing a live one
          pickedFolder: null,
          sessions: msg.sessions,
          revisions: msg.revisions,
          agents: msg.agents,
          nexts: msg.nexts,
          autonomous: msg.autonomous,
          filter,
          target: null,
          conn: "live",
          selection: null,
          hover: null,
          // every view opens at its own root layer: for the product view that
          // is the one bubble naming the whole product, which you drill into
          focus: null,
          view,
          viewPinnedAt: 0,
          parked: { product: NOWHERE, build: NOWHERE, infra: NOWHERE, correctness: NOWHERE },
          transcript: [],
          now: {},
          activity: {},
          activeNodes: NO_ACTIVE,
          activeAt: {},
          ptys: {},
          // another project's shell is not this one's: whatever the drawer was
          // showing belongs to the project that just went away
          terminalOpen: false,
          compare: null,
          delta: null,
          deltaContext: null,
        });
        return;
      }
      case "graph": {
        // what this variation's canvas held before the frame, so that what the
        // frame adds is exactly what the agent just wrote
        const had = new Set((get().graphs[msg.worktree]?.nodes ?? []).map((node) => node.id));
        set((s) => {
          const graphs = { ...s.graphs, [msg.worktree]: msg.graph };
          const next = remerged(s, graphs, s.filter);
          // The layer you were reading can be emptied out from under you: the
          // agent may drop the last capability, the last piece of
          // infrastructure or the last verification while you are standing in
          // it. Only the build layer is always a place to be — it is the one
          // reading with no precondition.
          const gone = !next.doc.nodes.some((node) => layerOf(node) === s.view);
          const emptied = s.view !== "build" && gone;
          // A canvas that was empty and now has a capability on it is a canvas
          // whose first bubble just arrived: show the layer it landed on rather
          // than leaving the user looking at an empty build view. Bubbles
          // landing on any other layer are followed below instead, where the
          // reader's own last choice can outvote them; this one cannot be
          // outvoted, because an empty build view is nowhere anybody chose to
          // stand.
          const born = s.doc.nodes.length === 0 && next.doc.nodes.some((node) => layerOf(node) === "product");
          const view: Layer = emptied ? "build" : born ? "product" : s.view;
          return { ...next, view };
        });
        // Bubbles arriving are a statement about where the work is, same as an
        // activity frame: an agent that just wrote the first parts of the thing
        // has moved on to building it. Only what is new counts — a status
        // refresh on bubbles the reader has already seen moves nobody.
        const added = msg.graph.nodes.filter((node) => !had.has(node.id)).map((node) => node.id);
        const arrived = following(get(), msg.worktree, added);
        if (arrived !== null) set(arrived);
        return;
      }
      case "agent":
        set((s) => ({ agents: { ...s.agents, [msg.worktree]: msg.state } }));
        return;
      case "next":
        set((s) => ({ nexts: { ...s.nexts, [msg.worktree]: msg.next } }));
        return;
      case "autonomous":
        set((s) => ({ autonomous: { ...s.autonomous, [msg.worktree]: msg.on } }));
        return;
      case "activity": {
        set((s) => {
          const activity = { ...s.activity, [msg.worktree]: new Set(msg.nodeIds) };
          return {
            activity,
            activeNodes: activeUnion(activity, s.filter),
            // an empty frame is a variation going quiet, which is not a claim
            // to be the one that worked on a bubble last
            activeAt:
              msg.nodeIds.length === 0 ? s.activeAt : { ...s.activeAt, [msg.worktree]: ++activityTick },
          };
        });
        // The room sends this right after every accepted call, naming exactly
        // the bubbles that call touched, so it is the plainest statement there
        // is of where the work is — and the canvas goes where the work is.
        const working = following(get(), msg.worktree, msg.nodeIds);
        if (working !== null) set(working);
        return;
      }
      case "transcript":
        get().appendTranscript(msg.worktree, msg.role, msg.text);
        return;
      case "revisions":
        set((s) => ({ revisions: { ...s.revisions, [msg.worktree]: msg.revisions } }));
        return;
      case "sessions":
        set({ sessions: msg.sessions });
        return;
      case "session":
        // Session facts only: an agent attaching, detaching or opening another
        // variation must not cost the reader their selection, their focus or
        // the transcript — that is what `hello` is for. A variation that went
        // away is dropped from the filter, or the canvas would be narrowed to
        // nothing that exists.
        set((s) => {
          const ids = sortedIds(msg.session.worktrees);
          const known = new Set(ids);
          const kept = s.filter === null ? null : new Set([...s.filter].filter((id) => known.has(id)));
          const filter = kept === null || kept.size === 0 || kept.size === ids.length ? null : kept;
          return { session: msg.session, worktreeIds: ids, ...remerged(s, s.graphs, filter) };
        });
        return;
      case "session_started":
        set((s) => ({
          session: withSession(s.session, msg.worktree, {
            session: msg.session,
            backend: msg.backend,
            state: "idle",
          }),
          agents: { ...s.agents, [msg.worktree]: "idle" },
        }));
        return;
      case "session_stopped": {
        const worktrees = get().session?.worktrees ?? NO_WORKTREES;
        set((s) => ({
          session:
            s.session === null
              ? null
              : { ...s.session, sessions: s.session.sessions.filter((entry) => entry.worktree !== msg.worktree) },
          agents: { ...s.agents, [msg.worktree]: "idle" },
          // a variation with no harness is not working on anything
          activity: { ...s.activity, [msg.worktree]: NO_ACTIVE },
          activeNodes: activeUnion({ ...s.activity, [msg.worktree]: NO_ACTIVE }, s.filter),
          // and it has no turn to end: the card's choices could not be sent
          // anywhere, and nothing is left to run on its own
          nexts: { ...s.nexts, [msg.worktree]: null },
          autonomous: { ...s.autonomous, [msg.worktree]: false },
          // nothing is being written here any more
          now: { ...s.now, [msg.worktree]: null },
        }));
        get().appendTranscript(
          msg.worktree,
          "tool",
          `the session on ${branchOf(worktrees, msg.worktree)} stopped: ${msg.reason}`,
        );
        return;
      }
      case "terminal":
        // The drawer shows ONE variation's shell — the one being steered — so a
        // frame about any other variation is about a terminal this screen is
        // not showing. It is broadcast to every attached tab, and a tab reading
        // another branch must not have the drawer thrown over its canvas.
        if (msg.worktree === selectTarget(get())) set({ terminalOpen: msg.open });
        return;
      case "now":
        set((s) => ({ now: { ...s.now, [msg.worktree]: msg.text } }));
        return;
      case "projects":
        set({ projects: msg.projects });
        return;
      case "folder_picked":
        // Every answer lands, cancel included: the reply is addressed to this
        // client alone, and a cancel is what releases the button that asked.
        // What it does NOT do is name a folder, so nothing gets opened.
        set({ pickedFolder: { path: msg.path, seq: ++keySeq } });
        return;
      case "delta": {
        // The answer is broadcast to every attached browser, so a client that
        // asked nothing — or asked about another variation — is not yanked into
        // someone else's comparison.
        const asked = get().compare;
        if (asked === null || asked.worktree !== msg.worktree) return;
        if (asked.revA !== msg.delta.revA || asked.revB !== msg.delta.revB) return;
        const live = get().graphs[msg.worktree];
        set({
          delta: msg.delta,
          deltaContext: live !== undefined && live.rev === msg.delta.revB ? live : null,
          // nothing on a past version is a legitimate steering target
          selection: null,
        });
        return;
      }
      case "error":
        // an unknown revision is answered with an error frame, so a request
        // still waiting for its answer is what just failed
        if (get().delta === null) set({ compare: null });
        get().pushError(msg.message);
        return;
    }
  },

  applyPty: (msg) => {
    switch (msg.type) {
      case "pty_data":
        // One pane, one shell: bytes from a variation nobody is looking at
        // would interleave into the target's scrollback. The bridge broadcasts
        // every variation's terminal, so the drop happens here.
        if (msg.worktree === selectTarget(get())) ptySink?.(msg.data);
        return;
      case "pty_state":
        set((s) => ({
          ptys: {
            ...s.ptys,
            [msg.worktree]: {
              open: msg.open,
              shell: msg.shell,
              cwd: msg.cwd,
              exited: msg.open ? null : (s.ptys[msg.worktree]?.exited ?? null),
            },
          },
        }));
        return;
      case "pty_exit":
        set((s) => ({
          ptys: {
            ...s.ptys,
            [msg.worktree]: { ...(s.ptys[msg.worktree] ?? NO_PTY), open: false, exited: { code: msg.code } },
          },
        }));
        return;
    }
  },

  setTerminal: (open) => set({ terminalOpen: open }),

  notify: (text) => {
    const id = ++keySeq;
    set({ notice: { seq: id, text } });
    // long enough to read six words, short enough that it never has to be
    // dismissed: the thing it reports on already happened somewhere else
    setTimeout(() => {
      if (get().notice?.seq === id) set({ notice: null });
    }, NOTICE_TTL_MS);
  },

  setConn: (conn) => set({ conn }),

  select: (referent) => set({ selection: referent }),

  setHover: (target) => set({ hover: target }),

  toggleReality: () => set((s) => ({ showReality: !s.showReality })),

  setProductFirst: (on) => set({ productFirst: on }),

  // the layer under the pointer is about to be replaced, so what it was over is
  // no longer under it
  setFocus: (focus) => set(() => ({ focus, hover: null })),

  setFilter: (ids) =>
    set((s) => {
      // "every variation" has one spelling, so a filter naming all of them is
      // the default rather than a second state that behaves like it
      const filter = ids === null || ids.size === 0 || ids.size === s.worktreeIds.length ? null : ids;
      saveFilter(s.projectId, filter);
      // a pinned target outside the filter is not on screen any more
      const target = s.target !== null && filter !== null && !filter.has(s.target) ? null : s.target;
      return { ...remerged(s, s.graphs, filter), target };
    }),

  setTarget: (worktree) => set({ target: worktree }),

  // Asked for by hand, which is the whole difference between this and the
  // canvas following the work: it stamps the pin, so the next few frames of
  // activity elsewhere leave the reader exactly where they put themselves.
  setView: (view) => set((s) => ({ ...switched(s, view), viewPinnedAt: Date.now() })),

  // The capability is parked as the build view's way back: Backspace out of the
  // "built by" layer restores this place, which is the product bubble you left,
  // selected — so the round trip ends where it started rather than at a root.
  drillRealizers: (productId) =>
    set((s) => ({
      view: "build",
      focus: realizesIdOf(productId),
      selection: null,
      parked: {
        ...s.parked,
        product: { focus: s.focus, selection: { kind: "node", id: productId } },
      },
      hover: null,
      viewPinnedAt: Date.now(),
    })),

  // The same round trip read from the infrastructure end: the piece of infra you
  // clicked is parked as the way back, so leaving the hosted parts lands on it
  // again rather than at the top of the infra layer.
  drillHosts: (infraId) =>
    set((s) => ({
      view: "build",
      focus: hostsIdOf(infraId),
      selection: null,
      parked: {
        ...s.parked,
        infra: { focus: s.focus, selection: { kind: "node", id: infraId } },
      },
      hover: null,
      viewPinnedAt: Date.now(),
    })),

  // And read from the verification end: the check you clicked is parked as the
  // way back, so leaving the parts it attests lands on it again rather than at
  // the top of the correctness layer.
  drillVerified: (verifyId) =>
    set((s) => ({
      view: "build",
      focus: verifiesIdOf(verifyId),
      selection: null,
      parked: {
        ...s.parked,
        correctness: { focus: s.focus, selection: { kind: "node", id: verifyId } },
      },
      hover: null,
      viewPinnedAt: Date.now(),
    })),

  // The fourth door, read from the build end: the part you clicked is parked as
  // the build view's way back, so leaving the checks that cover it lands on it
  // again rather than at the top of the build layer.
  drillCovering: (buildId) =>
    set((s) => ({
      view: "correctness",
      focus: coveredByIdOf(buildId),
      selection: null,
      parked: {
        ...s.parked,
        build: { focus: s.focus, selection: { kind: "node", id: buildId } },
      },
      hover: null,
      viewPinnedAt: Date.now(),
    })),

  // A capability named on a build bubble — or a realizer named on a capability —
  // is a link, not a hint: following it lands in that bubble's own layer, at the
  // altitude that shows it, selected.
  revealNode: (nodeId) =>
    set((s) => {
      const target = s.doc.nodes.find((node) => node.id === nodeId);
      if (target === undefined) return {};
      const view = layerOf(target);
      return {
        view,
        focus: target.parentId,
        selection: { kind: "node", id: nodeId },
        parked: { ...s.parked, [s.view]: { focus: s.focus, selection: s.selection } },
        hover: null,
        viewPinnedAt: Date.now(),
      };
    }),

  beginCompare: (worktree, revA, revB) =>
    set({ compare: { worktree, revA, revB }, delta: null, deltaContext: null }),

  exitCompare: () => set({ compare: null, delta: null, deltaContext: null, selection: null }),

  appendTranscript: (worktree, role, text) =>
    set((s) => {
      const next = [...s.transcript, { seq: ++keySeq, worktree, role, text }];
      return { transcript: next.length > TRANSCRIPT_CAP ? next.slice(next.length - TRANSCRIPT_CAP) : next };
    }),

  pushError: (message) => {
    const id = ++keySeq;
    set((s) => ({ errors: [...s.errors, { seq: id, message }] }));
    setTimeout(() => get().dismissError(id), ERROR_TTL_MS);
  },

  dismissError: (id) => set((s) => ({ errors: s.errors.filter((e) => e.seq !== id) })),
}));

/**
 * Which variation an utterance goes to.
 *
 * A pinned target wins while it is still on screen. Otherwise: the only
 * filtered variation with a harness in it, because with one running there is
 * nothing to choose; else the filtered variation that lit the selected bubble
 * most recently, because that is the one working on what the reader is looking
 * at; else the main worktree, which is the project itself. The last case can
 * name a variation with no harness — the steering bar then refuses the
 * utterance and says which variation to open, rather than sending it somewhere
 * else than the chip promised.
 */
export function selectTarget(state: AppState): string | null {
  const { session, filter, target } = state;
  if (session === null) return null;
  const shown = session.worktrees.filter((entry) => filter === null || filter.has(entry.id));
  if (target !== null && shown.some((entry) => entry.id === target)) return target;

  const running = shown.filter((entry) => runsIn(session, entry.id));
  if (running.length === 1) return running[0]?.id ?? null;

  const selected = state.selection?.kind === "node" ? state.selection.id : null;
  if (selected !== null) {
    let best: string | null = null;
    let bestAt = -1;
    for (const entry of shown) {
      if (!(state.activity[entry.id]?.has(selected) ?? false)) continue;
      const at = state.activeAt[entry.id] ?? 0;
      if (at <= bestAt) continue;
      best = entry.id;
      bestAt = at;
    }
    if (best !== null) return best;
  }

  const main = mainWorktreeOf(session);
  if (main !== null && shown.some((entry) => entry.id === main)) return main;
  return shown[0]?.id ?? null;
}

/** what the target variation's harness is doing — the state every control reads */
export function selectAgent(state: AppState): AgentState {
  const target = selectTarget(state);
  return target === null ? "idle" : (state.agents[target] ?? "idle");
}

/**
 * How many code-derived cards the canvas is drawing right now, for the reading
 * the reader is standing in. Three places ask the same question — the reality
 * toggle's count, the empty state's evidence that this checkout has code
 * nothing has mapped, and the catch-up button's count of parts no bubble
 * claims — so the question is asked once, here.
 */
export function selectGhostCount(state: AppState): number {
  return selectGhosts({ doc: state.doc, view: state.view, focus: state.focus }).nodes.length;
}

/**
 * The harness running in the target variation, or null when none is. What
 * drives a variation is a property of that variation now — two worktrees of one
 * repo can be running different backends — so everything that used to read one
 * project-wide backend reads the target's.
 */
export function selectRunningSession(state: AppState): WorktreeSession | null {
  const target = selectTarget(state);
  if (target === null || state.session === null) return null;
  return state.session.sessions.find((entry) => entry.worktree === target) ?? null;
}

/** the saved versions of the target variation's canvas, oldest first */
export function selectRevisions(state: AppState): RevisionInfo[] {
  const target = selectTarget(state);
  return target === null ? NO_REVISIONS : (state.revisions[target] ?? NO_REVISIONS);
}

/** the terminal the pane is showing: the target variation's */
export function selectPty(state: AppState): PtyView {
  const target = selectTarget(state);
  return target === null ? NO_PTY : (state.ptys[target] ?? NO_PTY);
}

/**
 * The card the steering bar sits under: the TARGET variation's, because that is
 * where a click on one of its choices would land. One card at a time on purpose
 * — two variations offering four buttons each is a menu, not a call to action.
 */
export function selectNext(state: AppState): Next | null {
  const target = selectTarget(state);
  return target === null ? null : (state.nexts[target] ?? null);
}

/** whether the target variation is deciding for itself right now */
export function selectAutonomous(state: AppState): boolean {
  const target = selectTarget(state);
  return target === null ? false : (state.autonomous[target] ?? false);
}

/** which variations hold one merged bubble; empty when only one is on screen */
export function whereOf(state: AppState, nodeId: string): readonly WhereMark[] {
  return state.where[nodeId] ?? NO_WHERE_MARKS;
}

/**
 * Some filtered variation is working but has not said where yet: streaming or
 * compacting with nothing of its own lit. That gap is what used to read as a
 * frozen screen, so it is derived once here and drawn as a breath on whatever
 * bubble the reader is looking at rather than as a second status widget.
 */
export function selectThinking(state: AppState): boolean {
  for (const [worktree, agent] of Object.entries(state.agents)) {
    if (agent === "idle") continue;
    if (state.filter !== null && !state.filter.has(worktree)) continue;
    if ((state.activity[worktree]?.size ?? 0) === 0) return true;
  }
  return false;
}

/** the "now" pill says one short line per branch; a whole tool invocation does not fit */
const NOW_MAX = 80;

/**
 * One line of the "now" pill: what a variation is doing, and what makes it the
 * same line as the one before it.
 *
 * The key is what the pill animates on. A harness writing a sentence keeps ONE
 * key while the text changes under it, so the words appear to be typed rather
 * than a new line being thrown up every few hundred milliseconds; a tool line's
 * key is its own text, so a different tool really is a new line and rises in.
 */
export interface NowLine {
  key: string;
  text: string;
}

/** a stable empty snapshot, so a quiet canvas never re-renders the pill */
export const NO_NOW: readonly NowLine[] = [];

/**
 * What one variation is doing this second: the sentence its harness is writing
 * right now if there is one, and otherwise the last tool line it broadcast.
 *
 * The live text wins because it is the newer fact — a harness that has been
 * writing prose for a minute is not still "reading merge.ts" — and it is
 * trimmed from its END: the words arriving are the ones worth reading, so a
 * long sentence loses its beginning rather than its point.
 */
function nowLineOf(state: AppState, worktree: string): NowLine | null {
  const live = (state.now[worktree] ?? "").replace(/\s+/g, " ").trim();
  if (live !== "") {
    const text = live.length > NOW_MAX ? `…${live.slice(live.length - NOW_MAX).trimStart()}` : live;
    return { key: `live:${worktree}`, text };
  }
  if (state.agents[worktree] === "compacting") return { key: `said:${worktree}`, text: "tidying up its memory" };
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const entry = state.transcript[i];
    if (entry === undefined || entry.worktree !== worktree || entry.role !== "tool") continue;
    const line = entry.text.replace(/\s+/g, " ").trim();
    if (line === "") return null;
    const text = line.length > NOW_MAX ? `${line.slice(0, NOW_MAX).trimEnd()}…` : line;
    return { key: `said:${worktree}:${text}`, text };
  }
  return null;
}

/**
 * The last snapshot the pill was given, and the signature it was built from. A
 * zustand selector must return the SAME reference while nothing it reads has
 * changed — a fresh array per store read re-renders forever — and the lines are
 * a list, not one string, because each carries its own identity.
 */
let nowCache: { sig: string; lines: readonly NowLine[] } = { sig: "", lines: NO_NOW };

/**
 * What is happening this second, in the agents' own words: one line per working
 * variation, prefixed with its branch when more than one variation is on screen
 * ("reminders: reading merge.ts").
 */
export function selectNow(state: AppState): readonly NowLine[] {
  const worktrees = state.session?.worktrees ?? NO_WORKTREES;
  const shown = worktrees.filter((entry) => state.filter === null || state.filter.has(entry.id));
  const lines: NowLine[] = [];
  let sig = "";
  for (const entry of shown) {
    if ((state.agents[entry.id] ?? "idle") === "idle") continue;
    const line = nowLineOf(state, entry.id);
    if (line === null) continue;
    const text = shown.length === 1 ? line.text : `${branchOf(worktrees, entry.id)}: ${line.text}`;
    lines.push({ key: line.key, text });
    sig += `${line.key}\u0000${text}\u0001`;
  }
  if (lines.length === 0) return NO_NOW;
  if (sig === nowCache.sig) return nowCache.lines;
  nowCache = { sig, lines };
  return lines;
}
