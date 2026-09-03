/**
 * Graph store: owns the single GraphDoc, applies `canvas` tool ops through the
 * shared validator, and persists to <dir>/graph.json — where that directory is
 * is the storage's business (`server/storage.ts`), not the store's.
 */

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { applyOps, emptyGraph } from "../../../shared/src/index.ts";
import type {
  CanvasOp,
  DriftMap,
  GraphDoc,
  GraphEdge,
  IntentNode,
  OpRejection,
  RealityLayer,
} from "../../../shared/src/index.ts";

/** receipt a gate supplies for a vetoed op; subject.path is op-relative
 *  (e.g. "/node/codeRefs/0") — the store absolutizes it to /ops/<i>/... */
export type GateVeto = Omit<OpRejection, "index">;

/** extra per-op veto layered on top of shared validation; null = accept */
export type OpGate = (op: CanvasOp) => GateVeto | null;

export interface CanvasToolOutcome {
  /** text content for host_tool_result */
  text: string;
  isError: boolean;
  /** true when doc.rev advanced — broadcast a graph frame */
  changed: boolean;
  /** transcript line for the side panel */
  transcript: string;
}

/** Boundary validator: the arguments came off the wire from the model. */
function parseCanvasArgs(raw: unknown): { ops: CanvasOp[]; note?: string } | string {
  if (raw === null || typeof raw !== "object") return "arguments must be an object with an `ops` array";
  if (!("ops" in raw) || !Array.isArray(raw.ops)) return "`ops` must be an array of canvas ops";
  if (raw.ops.length === 0) return "`ops` must contain at least one op";
  // Element shapes are validated per-op by shared applyOps, which rejects
  // anything malformed with a per-index reason.
  const ops = raw.ops as CanvasOp[];
  if ("note" in raw && typeof raw.note === "string") return { ops, note: raw.note };
  return { ops };
}

function describeOp(op: CanvasOp): string {
  switch (op?.op) {
    case "upsert_node":
      return `upsert node ${op.node?.id ?? "?"}`;
    case "remove_node":
      return `remove node ${op.id}`;
    case "upsert_edge":
      return `upsert edge ${op.edge?.id ?? "?"}`;
    case "remove_edge":
      return `remove edge ${op.id}`;
    case "set_phase":
      return `${op.id} -> ${op.phase}`;
    default:
      return "unknown op";
  }
}

export class GraphStore {
  doc: GraphDoc = emptyGraph();
  readonly #dir: string;
  readonly #file: string;
  #writing: Promise<void> = Promise.resolve();

  /** `dir` already includes whatever layout the storage chose for this project */
  constructor(dir: string) {
    this.#dir = dir;
    this.#file = join(dir, "graph.json");
  }

  get file(): string {
    return this.#file;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error(`[bridge] ignoring unparseable ${this.#file}`);
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const doc = emptyGraph();
    if ("rev" in parsed && typeof parsed.rev === "number") doc.rev = parsed.rev;
    if ("nodes" in parsed && Array.isArray(parsed.nodes)) doc.nodes = parsed.nodes as IntentNode[];
    if ("edges" in parsed && Array.isArray(parsed.edges)) doc.edges = parsed.edges as GraphEdge[];
    if ("reality" in parsed && parsed.reality !== null && typeof parsed.reality === "object") {
      doc.reality = parsed.reality as RealityLayer;
    }
    if ("drift" in parsed && parsed.drift !== null && typeof parsed.drift === "object") {
      doc.drift = parsed.drift as DriftMap;
    }
    this.doc = doc;
  }

  /** Serialized, last-write-wins persistence. */
  persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.doc, null, 2)}\n`;
    const tmp = `${this.#file}.tmp`;
    this.#writing = this.#writing.then(async () => {
      try {
        await mkdir(this.#dir, { recursive: true });
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, this.#file);
      } catch (err) {
        console.error(`[bridge] failed to persist graph: ${String(err)}`);
      }
    });
    return this.#writing;
  }

  node(id: string): IntentNode | undefined {
    return this.doc.nodes.find((n) => n.id === id);
  }

  edge(id: string): GraphEdge | undefined {
    return this.doc.edges.find((e) => e.id === id);
  }

  /**
   * Apply a `canvas` host tool call. Caller broadcasts/persists on `changed`.
   * `gate` is an extra per-op veto (onboarding validation mode); its reasons are
   * reported at the op's original index alongside shared validation rejections.
   */
  applyCanvasCall(rawArgs: unknown, gate: OpGate | null = null): CanvasToolOutcome {
    const parsed = parseCanvasArgs(rawArgs);
    if (typeof parsed === "string") {
      const receipt: OpRejection = {
        index: -1,
        code: "canvas/bad-args",
        severity: "error",
        message: parsed,
        subject: { path: "/ops" },
        evidence: {},
        supportedFixes: ["send { ops: CanvasOp[], note?: string } with at least one op"],
      };
      return {
        text: `applied 0 op(s); rev=${this.doc.rev}\n${JSON.stringify({ rejections: [receipt] }, null, 2)}`,
        isError: true,
        changed: false,
        transcript: `canvas: rejected (${parsed})`,
      };
    }

    const rejections: OpRejection[] = [];
    const admitted: CanvasOp[] = [];
    const originalIndex: number[] = [];
    parsed.ops.forEach((op, index) => {
      const veto = gate === null ? null : gate(op);
      if (veto !== null) {
        rejections.push({ ...veto, index, subject: { ...veto.subject, path: `/ops/${index}${veto.subject.path}` } });
        return;
      }
      admitted.push(op);
      originalIndex.push(index);
    });

    const before = this.doc.rev;
    const result = applyOps(this.doc, admitted);
    for (const r of result.rejections) {
      const index = originalIndex[r.index] ?? r.index;
      rejections.push({ ...r, index, subject: { ...r.subject, path: r.subject.path.replace(`/ops/${r.index}`, `/ops/${index}`) } });
    }
    rejections.sort((a, b) => a.index - b.index);

    // one-line human summary first, then the machine-readable repair receipts
    const lines = [`applied ${result.applied} op(s); rev=${this.doc.rev}`];
    if (rejections.length > 0) lines.push(JSON.stringify({ rejections }, null, 2));

    const summary = parsed.note ?? parsed.ops.map((op) => describeOp(op)).join(", ");
    return {
      text: lines.join("\n"),
      isError: result.applied === 0 && rejections.length > 0,
      changed: this.doc.rev !== before,
      transcript: `canvas: ${summary}`,
    };
  }

  setReality(reality: RealityLayer, drift: DriftMap): void {
    this.doc.reality = reality;
    this.doc.drift = drift;
    this.doc.rev++;
  }
}
