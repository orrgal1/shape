/**
 * The product-first turn (CONTRACTS.md § Product-first turn): the first thing
 * said about an empty canvas buys a picture of the product, not a build.
 *
 * Two halves live here, because they are the same rule seen from both sides:
 * the draft root the server writes the instant those words arrive — so the
 * canvas has something on it before the agent's first tool call — and the gate
 * that holds the turn to the product layer until the user has looked at it.
 *
 * Pure: the doc comes in, a veto comes out. The room owns when it is armed.
 */

import { layerOf } from "../../../shared/src/index.ts";
import type { CanvasOp, GraphDoc, IntentNode } from "../../../shared/src/index.ts";
import type { GateVeto, OpGate } from "./store.ts";

/** the draft root's id: the agent renames THIS bubble instead of adding its own */
export const DRAFT_ROOT_ID = "product";

/** what the draft root is called until the agent has a name for the product */
export const DRAFT_ROOT_LABEL = "Your idea";

/** what the draft root says it is doing while the agent works out what it is */
const DRAFT_ROOT_STATUS = "working out what this is…";

/** a summary is required and capped at 200 chars, so the sentence is cut to fit */
const SUMMARY_MAX = 200;

/** stands in for a promise when the user said nothing that reads as a sentence */
const NO_WORDS = "Not named yet — the first words are still being read.";

/**
 * The first sentence of what the user said, as the draft root's promise. Their
 * own words are the best summary available before the agent has read anything:
 * whitespace is collapsed so a dictated paragraph reads as one line, and a
 * sentence longer than the cap is cut rather than rejected.
 */
export function firstSentence(text: string): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (clean.length === 0) return NO_WORDS;
  const end = clean.search(/[.!?](\s|$)/u);
  const first = end === -1 ? clean : clean.slice(0, end + 1);
  if (first.length <= SUMMARY_MAX) return first;
  return `${first.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
}

/**
 * The `canvas` call the server makes on the user's behalf: one product root,
 * their own sentence as its promise, a status saying it is being worked out.
 * Applied through the store like any other call, so it snapshots and broadcasts
 * exactly like the agent's own work does.
 */
export function draftRootCall(text: string): { ops: CanvasOp[]; note: string } {
  return {
    ops: [
      {
        op: "upsert_node",
        node: {
          id: DRAFT_ROOT_ID,
          parentId: null,
          layer: "product",
          label: DRAFT_ROOT_LABEL,
          summary: firstSentence(text),
          phase: "idea",
          status: DRAFT_ROOT_STATUS,
        },
      },
    ],
    note: "a first sketch from your words",
  };
}

/** the one reason this gate ever gives, in the words the model has to act on */
const WHY =
  "product picture first: this turn is the product layer only — name the product, give it 3 to 5 capabilities, then stop and let the user look";

/**
 * Product-first validation mode: for the duration of the first turn on a canvas
 * that was empty, anything below the product layer is refused. Building before
 * the user has corrected the picture is the expensive kind of wrong — and a
 * `realizes` written now would name parts nobody has agreed to yet.
 *
 * Only `upsert_node` is gated: an edge or a phase change needs endpoints that
 * cannot exist yet, and removing a bubble is never the mistake this stops.
 *
 * The gate is created per canvas call, so a bubble this batch admits as a
 * capability counts as one for a later op in the SAME batch.
 */
export function productTurnGate(doc: Pick<GraphDoc, "nodes">): OpGate {
  const admittedProductIds = new Set<string>();
  const existing = (id: unknown): IntentNode | undefined =>
    typeof id === "string" ? doc.nodes.find((n) => n.id === id) : undefined;

  return (op): GateVeto | null => {
    if (op?.op !== "upsert_node") return null;
    const node = op.node;
    if (node === null || typeof node !== "object") return null;
    const subject = {
      path: "/node/layer",
      ...(typeof node.id === "string" ? { id: node.id } : {}),
      ...(typeof node.label === "string" ? { label: node.label } : {}),
    };

    // a layer sticks: an upsert that omits `layer` leaves the bubble where
    // shared validation leaves it, so the gate reads it the same way
    const prior = existing(node.id);
    const asked = node.layer;
    const layer =
      asked === "product" || asked === "build"
        ? asked
        : prior
          ? layerOf(prior)
          : typeof node.id === "string" && admittedProductIds.has(node.id)
            ? "product"
            : "build";

    if (layer === "build") {
      return {
        code: "product/first",
        severity: "error",
        message: `${WHY} — "${String(node.id)}" is a build bubble`,
        subject,
        evidence: { layer: "build" },
        supportedFixes: [
          `set layer to "product" and parentId to "${DRAFT_ROOT_ID}" if this is a capability the product promises`,
          "wait for the next turn to create build bubbles",
        ],
      };
    }

    const realizes = Array.isArray(node.realizes) ? node.realizes : [];
    if (realizes.length > 0) {
      return {
        code: "product/first",
        severity: "error",
        message: `${WHY} — "${String(node.id)}" already claims parts that make it real`,
        subject: { ...subject, path: "/node/realizes" },
        evidence: { realizes },
        supportedFixes: [
          "drop realizes for now and fill it in as the parts appear in a later turn",
        ],
      };
    }

    if (typeof node.id === "string") admittedProductIds.add(node.id);
    return null;
  };
}
