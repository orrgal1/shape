/**
 * Graph store: owns ONE worktree's GraphDoc, applies `canvas` tool ops through
 * the shared validator, and persists through the storage — where the graph
 * actually lives is the storage's business (`server/storage.ts`), not the
 * store's. A project has one of these per worktree; the view merges them.
 */

import { applyOps, emptyGraph, linkGapsOf, parseNext } from "../../../shared/src/index.ts";
import type {
  CanvasOp,
  DriftMap,
  GraphDoc,
  GraphEdge,
  IntentNode,
  LinkGap,
  OpRejection,
  RealityLayer,
} from "../../../shared/src/index.ts";
import type { Storage } from "./storage.ts";

export interface CanvasToolOutcome {
  /** text content for host_tool_result */
  text: string;
  isError: boolean;
  /** true when doc.rev advanced — broadcast a graph frame */
  changed: boolean;
  /** transcript line for the side panel */
  transcript: string;
  /**
   * Intent nodes this call created or updated, in op order. The canvas is what
   * the reader watches, so a call that lands is also what says where the agent
   * is working right now — no file path has to match for that to be true.
   */
  touched: string[];
  /**
   * Bubbles this call left unconnected across the layers (user decision
   * 2026-09-04: connection is the default). Same receipt shape as a rejection
   * and reported on the same text, but `severity: "warning"` — the op landed,
   * and what the canvas is saying is that the link it owes is still missing.
   */
  warnings: OpRejection[];
}

/**
 * Boundary validator: the arguments came off the wire from the model. `next` is
 * passed through unread — it is checked after the ops have applied, so a
 * malformed card costs the call nothing but its receipt and never its canvas
 * work.
 */
function parseCanvasArgs(raw: unknown): { ops: CanvasOp[]; note?: string; next?: unknown } | string {
  if (raw === null || typeof raw !== "object") return "arguments must be an object with an `ops` array";
  if (!("ops" in raw) || !Array.isArray(raw.ops)) return "`ops` must be an array of canvas ops";
  if (raw.ops.length === 0) return "`ops` must contain at least one op";
  // Element shapes are validated per-op by shared applyOps, which rejects
  // anything malformed with a per-index reason.
  const ops = raw.ops as CanvasOp[];
  const note = "note" in raw && typeof raw.note === "string" ? raw.note : undefined;
  const next = "next" in raw ? raw.next : undefined;
  return { ops, ...(note === undefined ? {} : { note }), ...(next === undefined ? {} : { next }) };
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

/**
 * What each kind of missing link says out loud, in the words the agent has to
 * act in: the link that closes it, and where that link lives. `field` is the
 * one the bubble owes itself — a capability's own `realizes`, an infra
 * bubble's own `hosts`, a check's own `verifies`. A build bubble owes no
 * cross-layer field of its own, so its gaps point at the whole node and every
 * fix is written on the other side.
 */
const LINK_GAP_RECEIPTS: Record<
  LinkGap,
  { field: string | null; say: (label: string) => string; fixes: string[] }
> = {
  unrealized: {
    field: "realizes",
    say: (label) =>
      `capability "${label}" names no build bubble in \`realizes\` — nothing on the build side makes it real`,
    fixes: [
      "set `realizes` to the ids of the build bubbles that make this capability real",
      "create the parts that deliver it and name their ids in `realizes` in the same call",
      "leave the capability at `idea` or `concept` until something on the build side exists",
    ],
  },
  unserved: {
    field: null,
    say: (label) =>
      `part "${label}" serves no capability — no capability's \`realizes\` names it or a bubble above it`,
    fixes: [
      "add this bubble's id to the `realizes` of the capability it delivers",
      "name the group above it in that `realizes` instead when the whole group serves one capability",
      "add the capability this part is for to the product layer, then name it there",
    ],
  },
  unhosted: {
    field: null,
    say: (label) =>
      `part "${label}" runs on nothing — no infrastructure bubble's \`hosts\` names it or a bubble above it`,
    fixes: [
      "add this bubble's id to the `hosts` of the infrastructure it runs on or uses",
      "name the group above it in that `hosts` instead when the whole group runs there",
    ],
  },
  unattested: {
    field: null,
    say: (label) =>
      `part "${label}" is built and nothing attests it — add or extend a check on the correctness layer with \`verifies\` naming it`,
    fixes: [
      "add or extend a correctness bubble whose `verifies` names this part",
      "put the part back to `building` until something proves it works",
    ],
  },
  "hosts-nothing": {
    field: "hosts",
    say: (label) => `infrastructure "${label}" runs nothing — name in \`hosts\` the build bubbles that run on it`,
    fixes: [
      "set `hosts` to the ids of the build bubbles that run on or use this infrastructure",
      "remove the bubble if nothing in this project runs on it",
    ],
  },
  "attests-nothing": {
    field: "verifies",
    say: (label) => `check "${label}" attests nothing — name in \`verifies\` the build bubbles it proves correct`,
    fixes: [
      "set `verifies` to the ids of the build bubbles this check attests",
      "remove the bubble if nothing on the canvas is what it checks",
    ],
  },
};

/**
 * The connection the bubbles this call touched still owe (user decision
 * 2026-09-04). A warning, never a refusal: the op landed, and the canvas is
 * saying out loud that the bubble is not reachable from the other layers yet,
 * which is the thing the agent closes in the same turn. `linkGapsOf` in
 * shared/ is the only place that question is answered — the store reads it,
 * the same way the canvas and the side panel do.
 */
function linkWarnings(doc: Pick<GraphDoc, "nodes" | "reality">, touched: ReadonlyMap<string, number>): OpRejection[] {
  const warnings: OpRejection[] = [];
  for (const [id, index] of touched) {
    const node = doc.nodes.find((n) => n.id === id);
    if (node === undefined) continue;
    for (const gap of linkGapsOf(doc, id)) {
      const receipt = LINK_GAP_RECEIPTS[gap];
      warnings.push({
        index,
        code: `link/${gap}`,
        severity: "warning",
        message: receipt.say(node.label),
        subject: {
          path: `/ops/${index}/node${receipt.field === null ? "" : `/${receipt.field}`}`,
          id,
          label: node.label,
        },
        evidence: { gap },
        supportedFixes: receipt.fixes,
      });
    }
  }
  return warnings;
}

/**
 * The correctness layer was called "verify" until it was renamed, so a row
 * written before then still says so. Loading maps it; the wire does not — an
 * op that sends the old value is rejected like any other unknown layer.
 */
function migrateLayer(node: IntentNode): IntentNode {
  return (node.layer as string | undefined) === "verify" ? { ...node, layer: "correctness" } : node;
}

export class GraphStore {
  doc: GraphDoc = emptyGraph();
  readonly #storage: Storage;
  readonly #tenant: string;
  readonly #key: string;
  readonly #worktree: string;

  /** ONE worktree's graph of one project, under the tenant that owns it */
  constructor(storage: Storage, tenant: string, key: string, worktree: string) {
    this.#storage = storage;
    this.#tenant = tenant;
    this.#key = key;
    this.#worktree = worktree;
  }

  /**
   * Read this worktree's stored graph, if it has one. A record written by an
   * older bridge is taken field by field rather than trusted whole: a missing
   * or malformed part costs that part, never the project.
   */
  async load(): Promise<void> {
    const stored: unknown = await this.#storage.loadGraph(this.#tenant, this.#key, this.#worktree);
    if (stored === null || typeof stored !== "object") return;
    const doc = emptyGraph();
    if ("rev" in stored && typeof stored.rev === "number") doc.rev = stored.rev;
    if ("nodes" in stored && Array.isArray(stored.nodes)) doc.nodes = (stored.nodes as IntentNode[]).map(migrateLayer);
    if ("edges" in stored && Array.isArray(stored.edges)) doc.edges = stored.edges as GraphEdge[];
    if ("reality" in stored && stored.reality !== null && typeof stored.reality === "object") {
      // a row written before parts, infrastructure or verification existed has
      // none of those lists, and every reader (the mechanical skeleton, drift,
      // the client) expects arrays
      const stale = stored.reality as RealityLayer;
      doc.reality = {
        ...stale,
        symbols: Array.isArray(stale.symbols) ? stale.symbols : [],
        infra: Array.isArray(stale.infra) ? stale.infra : [],
        verification: Array.isArray(stale.verification) ? stale.verification : [],
      };
    }
    if ("drift" in stored && stored.drift !== null && typeof stored.drift === "object") {
      doc.drift = stored.drift as DriftMap;
    }
    // a row written before the mark existed has none, which reads as "never
    // mapped" — exactly what it was
    if ("surveyed" in stored && stored.surveyed !== null && typeof stored.surveyed === "object") {
      doc.surveyed = stored.surveyed as { head: string | null; at: string };
    }
    this.doc = doc;
  }

  /** Last-write-wins persistence; a store that cannot write costs the turn nothing. */
  async persist(): Promise<void> {
    try {
      await this.#storage.saveGraph(this.#tenant, this.#key, this.#worktree, this.doc);
    } catch (err) {
      console.error(`[bridge] failed to persist graph: ${String(err)}`);
    }
  }

  node(id: string): IntentNode | undefined {
    return this.doc.nodes.find((n) => n.id === id);
  }

  edge(id: string): GraphEdge | undefined {
    return this.doc.edges.find((e) => e.id === id);
  }

  /**
   * Apply a `canvas` host tool call. Caller broadcasts/persists on `changed`.
   * `linkWarnings` is the connection-is-the-default half: on by default, and
   * turned off for the mechanical skeleton the server seeds by itself, which is
   * one flat pile of parts with nothing to be connected to yet.
   */
  applyCanvasCall(rawArgs: unknown, opts: { linkWarnings?: boolean } = {}): CanvasToolOutcome {
    const parsed = parseCanvasArgs(rawArgs);
    if (typeof parsed === "string") {
      const receipt: OpRejection = {
        index: -1,
        code: "canvas/bad-args",
        severity: "error",
        message: parsed,
        subject: { path: "/ops" },
        evidence: {},
        supportedFixes: ["send { ops: CanvasOp[], note?: string, next?: Next } with at least one op"],
      };
      return {
        text: `applied 0 op(s); rev=${this.doc.rev}\n${JSON.stringify({ rejections: [receipt] }, null, 2)}`,
        isError: true,
        changed: false,
        transcript: `canvas: rejected (${parsed})`,
        touched: [],
        warnings: [],
      };
    }

    const before = this.doc.rev;
    const result = applyOps(this.doc, parsed.ops);
    const rejections = [...result.rejections];

    // Which bubbles this call actually moved, and the op that moved each: an op
    // the validator refused never touched anything, and its index is the one
    // thing that says so. The index is what a link warning is reported at, so
    // the first op that wrote a bubble is the one that hears about it.
    const refused = new Set(result.rejections.map((r) => r.index));
    const touched: string[] = [];
    const touchedAt = new Map<string, number>();
    parsed.ops.forEach((op, index) => {
      if (refused.has(index)) return;
      const remember = (id: unknown): void => {
        if (typeof id !== "string" || id === "") return;
        touched.push(id);
        if (!touchedAt.has(id)) touchedAt.set(id, index);
      };
      if (op?.op === "upsert_node") {
        remember(op.node?.id);
        return;
      }
      if (op?.op === "set_phase") remember(op.id);
    });

    // The card the turn ends on, checked last and then dropped: `next` is part
    // of the tool contract, so a session on a harness that still sends one is
    // not made to change its calls, and a malformed card is still worth a
    // receipt — but Shape is a picture now, and nothing here or above reads a
    // card. It is not an op either, so the receipt names no op index (like
    // `canvas/bad-args`) and the ops that landed still stand.
    if (parsed.next !== undefined) {
      const checked = parseNext(parsed.next);
      if (typeof checked === "string") {
        rejections.unshift({
          index: -1,
          code: "op/bad-next",
          severity: "error",
          message: checked,
          subject: { path: "/next" },
          evidence: { next: parsed.next },
          supportedFixes: [
            "send next as { summary: one sentence <= 200 chars, choices: up to 4 { label <= 40 chars, say }, question: string | null }",
            "leave `next` off this call",
          ],
        });
      }
    }

    // What the bubbles this call wrote are still not connected to. Read after
    // the ops have applied, so it is the graph as it now stands that answers —
    // and skipped entirely by a call that applied nothing, which has no bubble
    // of its own to be unconnected.
    const warnings =
      opts.linkWarnings === false || result.applied === 0 ? [] : linkWarnings(this.doc, touchedAt);

    // one-line human summary first, then the machine-readable receipts: what
    // was refused, then what landed with a link still owed
    const lines = [`applied ${result.applied} op(s); rev=${this.doc.rev}`];
    if (rejections.length > 0) lines.push(JSON.stringify({ rejections }, null, 2));
    if (warnings.length > 0) lines.push(JSON.stringify({ warnings }, null, 2));

    const summary = parsed.note ?? parsed.ops.map((op) => describeOp(op)).join(", ");
    return {
      text: lines.join("\n"),
      isError: result.applied === 0 && rejections.length > 0,
      changed: this.doc.rev !== before,
      transcript: `canvas: ${summary}`,
      touched,
      warnings,
    };
  }

  setReality(reality: RealityLayer, drift: DriftMap): void {
    this.doc.reality = reality;
    this.doc.drift = drift;
    this.doc.rev++;
  }

  /**
   * This canvas was just mapped against the code: the mechanical skeleton has
   * landed on it. A revision like any other, so the mark is persisted and
   * broadcast with the graph it belongs to — the room reads it back to decide
   * whether this HEAD has already been drawn (server/room.ts).
   */
  setSurveyed(surveyed: { head: string | null; at: string }): void {
    this.doc.surveyed = surveyed;
    this.doc.rev++;
  }
}
