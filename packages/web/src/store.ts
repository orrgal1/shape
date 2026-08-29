import { create } from "zustand";
import {
  emptyGraph,
  type AgentState,
  type GraphDoc,
  type Referent,
  type ServerMsg,
  type SessionInfo,
} from "../../shared/src/index.ts";

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
  conn: ConnStatus;
  errors: ErrorToast[];
  showReality: boolean;
  /** the drilled-into bubble; null is the project root layer */
  focus: string | null;
  /** project paths offered by the bridge in `hello`, most recent first */
  recentProjects: string[];

  /** single funnel for everything arriving from the bridge */
  ingest: (msg: ServerMsg) => void;
  setConn: (conn: ConnStatus) => void;
  select: (referent: Referent | null) => void;
  toggleReality: () => void;
  setFocus: (nodeId: string | null) => void;
  appendTranscript: (role: TranscriptRole, text: string) => void;
  pushError: (message: string) => void;
  dismissError: (seq: number) => void;
}

/** a selection only survives while its target still exists in the graph */
function keepSelection(selection: Referent | null, doc: GraphDoc): Referent | null {
  if (selection === null) return null;
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
  conn: "connecting",
  errors: [],
  showReality: true,
  focus: null,
  recentProjects: [],

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
          agent: msg.agent,
          conn: "live",
          selection: null,
          focus: null,
          transcript: [],
          activity: new Set<string>(),
        });
        return;
      case "graph":
        set((s) => ({
          doc: msg.graph,
          selection: keepSelection(s.selection, msg.graph),
          // a focus whose bubble the agent deleted falls back to the root layer
          focus: s.focus !== null && msg.graph.nodes.some((n) => n.id === s.focus) ? s.focus : null,
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
      case "error":
        get().pushError(msg.message);
        return;
    }
  },

  setConn: (conn) => set({ conn }),

  select: (referent) => set({ selection: referent }),

  toggleReality: () => set((s) => ({ showReality: !s.showReality })),

  setFocus: (focus) => set({ focus }),

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
