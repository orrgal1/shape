import { create } from "zustand";
import {
  emptyGraph,
  layerOf,
  type AgentState,
  type DiscoveredSession,
  type GraphDelta,
  type GraphDoc,
  type Layer,
  type ProjectSummary,
  type Referent,
  type RevisionInfo,
  type ServerMsg,
  type SessionInfo,
} from "../../shared/src/index.ts";
import type { PtyServerMsg } from "../../shared/src/pty.ts";
import { isMoreId, isRealizesId, moreBaseOf, realizesIdOf, realizesProductOf } from "./layer.ts";

/**
 * What the bridge's shell is doing. Terminal *output* is deliberately absent:
 * a shell printing a thousand lines must not re-render the app, so bytes go
 * straight to the xterm instance through `setPtySink` instead of state.
 */
export interface PtyView {
  /** the bridge has a live shell right now */
  open: boolean;
  shell: string;
  cwd: string;
  /** set when the shell exited on its own; cleared when one starts again */
  exited: { code: number | null } | null;
}

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

/** monotonic key source for transcript entries and error toasts */
let keySeq = 0;

export interface AppState {
  doc: GraphDoc;
  session: SessionInfo | null;
  agent: AgentState;
  /** intent node ids the agent is working inside right now */
  activity: ReadonlySet<string>;
  transcript: TranscriptEntry[];
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
   * Which layer of the project is on the canvas: the capabilities it promises a
   * person, or the parts that build them. One canvas, two readings — never both
   * at once, because a capability and a package are not peers.
   */
  view: Layer;
  /** the drilled-into bubble, fold or realizes drill; null is the layer's root */
  focus: string | null;
  /**
   * Where the other view was left. Reading a layer is a place you stand, so
   * switching away and back returns you to it rather than to its root — and
   * arriving in one from the other (a "built by" drill) is what parks the
   * capability as the selection to come back to.
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
   * Agent sessions running on this machine, newest first — the adopt list. The
   * bridge refreshes it on every hello and on demand (`discover`).
   */
  sessions: DiscoveredSession[];
  /** saved versions of this project's canvas the bridge can compare, oldest first */
  revisions: RevisionInfo[];
  /** the pair a comparison was asked about; set the moment the request goes out */
  compare: { revA: number; revB: number } | null;
  /** the answer on screen; null means the canvas is showing the project as it is now */
  delta: GraphDelta | null;
  /**
   * The live graph as it stood when the answer landed, kept only when it IS the
   * after side of the comparison. Frozen on purpose: a `graph` frame arriving
   * later must not quietly rewrite what a comparison claims, and a graph that
   * has moved past `revB` is no longer evidence about `revB`.
   */
  deltaContext: GraphDoc | null;

  /** the terminal pane is on screen, covering the canvas */
  terminalOpen: boolean;
  pty: PtyView;

  /** single funnel for everything arriving from the bridge */
  ingest: (msg: ServerMsg) => void;
  /** terminal frames have their own wire; they never touch the graph */
  applyPty: (msg: PtyServerMsg) => void;
  toggleTerminal: () => void;
  setConn: (conn: ConnStatus) => void;
  select: (referent: Referent | null) => void;
  /** what the pointer is over, which is what reveals a stroke's words */
  setHover: (target: HoverTarget | null) => void;
  toggleReality: () => void;
  setFocus: (nodeId: string | null) => void;
  /** switch layers, restoring where that layer was last left */
  setView: (view: Layer) => void;
  /** product → build: show exactly the bubbles that make one capability real */
  drillRealizers: (productId: string) => void;
  /**
   * Put one bubble on screen wherever it lives: the layer it belongs to, the
   * altitude that shows it, selected. This is what following a cross-layer chip
   * does, in either direction.
   */
  revealNode: (nodeId: string) => void;
  beginCompare: (revA: number, revB: number) => void;
  exitCompare: () => void;
  appendTranscript: (role: TranscriptRole, text: string) => void;
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
 * A focus only survives while the thing it names can still exist. Two of the
 * three kinds are synthetic — never in the document — so what has to still be
 * there is the bubble whose layer folded, the capability a realizes drill asks
 * about, or nothing at all for a root layer.
 */
function keepFocus(focus: string | null, doc: GraphDoc): string | null {
  if (focus === null) return null;
  const product = realizesProductOf(focus);
  if (product !== null) return doc.nodes.some((node) => node.id === product) ? focus : null;
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

export const useApp = create<AppState>((set, get) => ({
  doc: emptyGraph(),
  session: null,
  agent: "idle",
  activity: new Set<string>(),
  transcript: [],
  selection: null,
  hover: null,
  conn: "connecting",
  errors: [],
  showReality: true,
  view: "build",
  focus: null,
  parked: { product: NOWHERE, build: NOWHERE },
  recentProjects: [],
  projects: [],
  projectId: null,
  sessions: [],
  revisions: [],
  compare: null,
  delta: null,
  deltaContext: null,
  terminalOpen: false,
  pty: { open: false, shell: "", cwd: "", exited: null },

  ingest: (msg) => {
    switch (msg.type) {
      case "hello": {
        // A canvas with capabilities on it leads with them: what the project
        // promises a person is the reading that makes its parts make sense. A
        // project with none is a build-only project and opens as one.
        const view: Layer = msg.graph.nodes.some((node) => layerOf(node) === "product") ? "product" : "build";
        // `hello` also arrives after a successful switch_project, so everything
        // scoped to a session is dropped here. Carrying a selection, a focus or
        // a transcript across projects would attribute one project's work to
        // another — worse than losing scroll position.
        set({
          doc: msg.graph,
          session: msg.session,
          recentProjects: msg.recentProjects,
          projects: msg.projects,
          projectId: msg.projectId,
          sessions: msg.sessions,
          revisions: msg.revisions,
          agent: msg.agent,
          conn: "live",
          selection: null,
          hover: null,
          // both views open at their own root layer: for the product view that
          // is the one bubble naming the whole product, which you drill into
          focus: null,
          view,
          parked: { product: NOWHERE, build: NOWHERE },
          transcript: [],
          activity: new Set<string>(),
          compare: null,
          delta: null,
          deltaContext: null,
        });
        return;
      }
      case "graph":
        set((s) => {
          const gone = s.view === "product" && !msg.graph.nodes.some((node) => layerOf(node) === "product");
          // the layer you were reading can be emptied out from under you
          const view: Layer = gone ? "build" : s.view;
          return {
            doc: msg.graph,
            selection: keepSelection(s.selection, msg.graph),
            // A focus whose bubble the agent deleted falls back to the layer's
            // home: the root of the build layer, the product itself in the
            // product layer — including when the deleted bubble was the product
            // and a renamed one took its place.
            focus: keepFocus(s.focus, msg.graph),
            view,
            parked: {
              product: {
                focus: keepFocus(s.parked.product.focus, msg.graph),
                selection: keepSelection(s.parked.product.selection, msg.graph),
              },
              build: {
                focus: keepFocus(s.parked.build.focus, msg.graph),
                selection: keepSelection(s.parked.build.selection, msg.graph),
              },
            },
            // the pointer's target is about the frame that was on screen
            hover: null,
          };
        });
        return;
      case "agent":
        set({ agent: msg.state });
        return;
      case "activity":
        set({ activity: new Set(msg.nodeIds) });
        return;
      case "transcript":
        get().appendTranscript(msg.role, msg.text);
        return;
      case "revisions":
        set({ revisions: msg.revisions });
        return;
      case "sessions":
        set({ sessions: msg.sessions });
        return;
      case "session":
        // Session facts only: an agent attaching, detaching or reporting its
        // harness session id must not cost the reader their selection, their
        // focus or the transcript — that is what `hello` is for.
        set({ session: msg.session });
        return;
      case "projects":
        set({ projects: msg.projects });
        return;
      case "delta": {
        // The answer is broadcast to every attached browser, so a client that
        // asked nothing is not yanked into someone else's comparison.
        const asked = get().compare;
        if (asked === null || asked.revA !== msg.delta.revA || asked.revB !== msg.delta.revB) return;
        const live = get().doc;
        set({
          delta: msg.delta,
          deltaContext: live.rev === msg.delta.revB ? live : null,
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
        // straight to the terminal that is drawing; see PtyView
        ptySink?.(msg.data);
        return;
      case "pty_state":
        set((s) => ({
          pty: { open: msg.open, shell: msg.shell, cwd: msg.cwd, exited: msg.open ? null : s.pty.exited },
        }));
        return;
      case "pty_exit":
        set((s) => ({ pty: { ...s.pty, open: false, exited: { code: msg.code } } }));
        return;
    }
  },

  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),

  setConn: (conn) => set({ conn }),

  select: (referent) => set({ selection: referent }),

  setHover: (target) => set({ hover: target }),

  toggleReality: () => set((s) => ({ showReality: !s.showReality })),

  // the layer under the pointer is about to be replaced, so what it was over is
  // no longer under it
  setFocus: (focus) => set(() => ({ focus, hover: null })),

  setView: (view) =>
    set((s) => {
      // Clicking the layer you are already in, while the canvas is answering a
      // question about the other one, means "just show me this layer" — so the
      // realizes drill is what gets dropped. Without this the build root is
      // unreachable from a "built by" layer without walking through a bubble.
      if (view === s.view) {
        return s.focus !== null && isRealizesId(s.focus) ? { focus: null, hover: null } : {};
      }
      // a "built by" drill is a one-shot detour, not a place: leaving it parks
      // the build root, so toggling back lands on the build view's real home
      const here: ViewPlace =
        s.focus !== null && isRealizesId(s.focus) ? { focus: null, selection: null } : { focus: s.focus, selection: s.selection };
      const there = s.parked[view];
      return {
        view,
        focus: there.focus,
        selection: there.selection,
        parked: { ...s.parked, [s.view]: here },
        hover: null,
      };
    }),

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
      };
    }),

  beginCompare: (revA, revB) => set({ compare: { revA, revB }, delta: null, deltaContext: null }),

  exitCompare: () => set({ compare: null, delta: null, deltaContext: null, selection: null }),

  appendTranscript: (role, text) =>
    set((s) => {
      const next = [...s.transcript, { seq: ++keySeq, role, text }];
      return { transcript: next.length > TRANSCRIPT_CAP ? next.slice(next.length - TRANSCRIPT_CAP) : next };
    }),

  pushError: (message) => {
    const id = ++keySeq;
    set((s) => ({ errors: [...s.errors, { seq: id, message }] }));
    setTimeout(() => get().dismissError(id), ERROR_TTL_MS);
  },

  dismissError: (id) => set((s) => ({ errors: s.errors.filter((e) => e.seq !== id) })),
}));
