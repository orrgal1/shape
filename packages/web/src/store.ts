import { create } from "zustand";
import {
  emptyGraph,
  type AgentState,
  type DiscoveredSession,
  type GraphDelta,
  type GraphDoc,
  type Referent,
  type RevisionInfo,
  type ServerMsg,
  type SessionInfo,
} from "../../shared/src/index.ts";
import type { PtyServerMsg } from "../../shared/src/pty.ts";
import { isMoreId, moreBaseOf } from "./layer.ts";

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
  /** the drilled-into bubble or fold; null is the project root layer */
  focus: string | null;
  /** project paths offered by the bridge in `hello`, most recent first */
  recentProjects: string[];
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

/**
 * A focus only survives while the thing it names can still exist. A fold is
 * synthetic — it is never in the document — so what has to still be there is
 * the bubble whose layer folded, or nothing at all for the root layer.
 */
function keepFocus(focus: string | null, doc: GraphDoc): string | null {
  if (focus === null) return null;
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
  focus: null,
  recentProjects: [],
  sessions: [],
  revisions: [],
  compare: null,
  delta: null,
  deltaContext: null,
  terminalOpen: false,
  pty: { open: false, shell: "", cwd: "", exited: null },

  ingest: (msg) => {
    switch (msg.type) {
      case "hello":
        // `hello` also arrives after a successful switch_project, so everything
        // scoped to a session is dropped here. Carrying a selection, a focus or
        // a transcript across projects would attribute one project's work to
        // another — worse than losing scroll position.
        set({
          doc: msg.graph,
          session: msg.session,
          recentProjects: msg.recentProjects,
          sessions: msg.sessions,
          revisions: msg.revisions,
          agent: msg.agent,
          conn: "live",
          selection: null,
          hover: null,
          focus: null,
          transcript: [],
          activity: new Set<string>(),
          compare: null,
          delta: null,
          deltaContext: null,
        });
        return;
      case "graph":
        set((s) => ({
          doc: msg.graph,
          selection: keepSelection(s.selection, msg.graph),
          // a focus whose bubble the agent deleted falls back to the root layer
          focus: keepFocus(s.focus, msg.graph),
          // the pointer's target is about the frame that was on screen
          hover: null,
        }));
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
  setFocus: (focus) => set({ focus, hover: null }),

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
