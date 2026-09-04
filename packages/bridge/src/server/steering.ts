/**
 * Steering composition (CONTRACTS.md § Steering composition): a click referent
 * plus an utterance become one addressed instruction for the running session.
 * The turn boundary is composed here too — the card a turn ends on when the
 * agent sent none, and the sentence autonomous mode answers it with.
 */

import { layerOf, linkGapsOf, productRootOf, realizersOf, servesOf } from "../../../shared/src/index.ts";
import type { LinkGap, Next, Referent } from "../../../shared/src/index.ts";
import { DRAFT_ROOT_ID, DRAFT_ROOT_LABEL, firstSentence } from "./productturn.ts";
import type { GraphStore } from "./store.ts";

const REMINDER = "Apply the change and keep the canvas current via the canvas tool.";

/**
 * What autonomous mode says on the user's behalf at the end of a turn. It is a
 * prompt like any other, and it is deliberately one paragraph: the agent is
 * being told to make the call it would have recommended, not being handed a
 * new task.
 */
export const AUTO_CONTINUE_PROMPT =
  "Autonomous mode is on. Decide for yourself: take the option you would recommend, answer your own " +
  "open question with the safest reasonable choice, and keep going until the work is finished. Do not stop to ask.";

/**
 * The card a turn ends on when the agent sent none. It is not a guess about
 * what to do next — the agent's own last sentence is the summary, and the two
 * choices are the two things anyone asks at that point.
 */
export function synthesizeNext(lastText: string): Next {
  return {
    summary: lastText.trim().length === 0 ? "The agent finished its turn." : firstSentence(lastText),
    choices: [
      { label: "Keep going", say: "Keep going with the plan." },
      { label: "What changed?", say: "Summarize what you changed and what is left." },
    ],
    question: null,
  };
}

function neighborsOfNode(store: GraphStore, id: string, isProductRoot: boolean): string[] {
  const out: string[] = [];
  const node = store.node(id);
  if (node?.parentId != null) out.push(`${node.parentId} [parent]`);
  for (const child of store.doc.nodes) {
    if (child.parentId !== id) continue;
    // the product root's children ARE the product's capabilities, so name them
    out.push(isProductRoot ? `${nameOf(store, child.id)} [capability]` : `${child.id} [child]`);
  }
  for (const edge of store.doc.edges) {
    const other = edge.source === id ? edge.target : edge.target === id ? edge.source : null;
    if (other === null) continue;
    const rel = edge.label === undefined ? edge.kind : `${edge.kind} "${edge.label}"`;
    out.push(`${other} [${rel}]`);
  }
  return out;
}

/** `id "Label"` — the agent needs the id to act and the user's words to understand. */
function nameOf(store: GraphStore, id: string): string {
  const node = store.node(id);
  return node === undefined ? id : `${id} "${node.label}"`;
}

/**
 * What a missing cross-layer link says to the agent about the bubble the user
 * is pointing at. `unrealized` is absent on purpose: a capability's own
 * "Realized by: nothing yet" line below already says exactly that, and the
 * block says each thing once.
 */
const GAP_LINES: Record<Exclude<LinkGap, "unrealized">, string> = {
  unserved: "no capability names this part in `realizes` — nothing above it says what it is for",
  unhosted: "no piece of infrastructure names this part in `hosts` — nothing says where it runs",
  unattested:
    "this part is built and nothing attests it — no check on the correctness layer names it in `verifies`",
  "hosts-nothing": "nothing runs on this — its `hosts` names no part of the build layer",
  "attests-nothing": "this check attests nothing — its `verifies` names no part of the build layer",
};

/**
 * The cross-layer lines: a capability names the parts that make it real, a
 * part names the capabilities it serves, and every bubble is told which of the
 * links it owes is still missing (user decision 2026-09-04: connection is the
 * default, so the bubble the user is pointing at says so out loud). Kept out
 * of `Neighbors` on purpose — neighbors are same-layer relations, these are
 * the bridge between the layers. The product root gets none: it stands for the
 * whole build layer, and its capabilities are already listed as its neighbors.
 */
function layerLines(store: GraphStore, id: string, isProductRoot: boolean): string[] {
  if (isProductRoot) return [];
  const lines: string[] = [];
  if (layerOf(store.node(id) ?? {}) === "product") {
    const realizers = realizersOf(store.doc, id);
    lines.push(
      realizers.length > 0
        ? `Realized by: ${realizers.map((r) => nameOf(store, r)).join(", ")}`
        : "Realized by: nothing yet — no part on the build side makes this capability real, so building it is the work.",
    );
  } else {
    const serves = servesOf(store.doc, id);
    if (serves.length > 0) lines.push(`Serves: ${serves.map((s) => nameOf(store, s)).join(", ")}`);
  }
  for (const gap of linkGapsOf(store.doc, id)) {
    if (gap === "unrealized") continue;
    lines.push(`Missing link: ${GAP_LINES[gap]}`);
  }
  return lines;
}

/**
 * Renders the `<canvas-steering>` block when a referent resolves, otherwise the
 * raw utterance plus the one-line canvas reminder.
 */
export function composeUtterance(store: GraphStore, text: string, referent: Referent | null): string {
  const said = `User said: "${text}"`;

  if (referent !== null && referent.kind === "node") {
    const node = store.node(referent.id);
    if (node !== undefined) {
      const isProductRoot = productRootOf(store.doc)?.id === node.id;
      const neighbors = neighborsOfNode(store, node.id, isProductRoot);
      const kind = isProductRoot ? "the product" : layerOf(node) === "product" ? "product capability" : "component";
      return [
        "<canvas-steering>",
        `Referent: ${kind} "${node.label}" (id: ${node.id}) — "${node.summary}" (phase: ${node.phase})`,
        ...layerLines(store, node.id, isProductRoot),
        `Neighbors: ${neighbors.length > 0 ? neighbors.join(", ") : "none"}`,
        said,
        REMINDER,
        "</canvas-steering>",
      ].join("\n");
    }
  }

  if (referent !== null && referent.kind === "edge") {
    const edge = store.edge(referent.id);
    if (edge !== undefined) {
      const source = store.node(edge.source);
      const target = store.node(edge.target);
      const label = edge.label === undefined ? "" : ` "${edge.label}"`;
      const endpoints = [source, target]
        .filter((n) => n !== undefined)
        .map((n) => `${n.id} "${n.label}" — "${n.summary}" (phase: ${n.phase})`);
      return [
        "<canvas-steering>",
        `Referent: edge${label} (id: ${edge.id}) — ${edge.kind} from ${edge.source} to ${edge.target}`,
        `Neighbors: ${endpoints.length > 0 ? endpoints.join("; ") : "none"}`,
        said,
        REMINDER,
        "</canvas-steering>",
      ].join("\n");
    }
  }

  if (referent !== null) {
    return [
      "<canvas-steering>",
      `Referent: ${referent.kind} "${referent.id}" — NOT FOUND on the canvas; the user clicked something the graph no longer describes.`,
      said,
      REMINDER,
      "</canvas-steering>",
    ].join("\n");
  }

  return `${text}\n\n${REMINDER}`;
}

/**
 * The first thing said about a canvas that was empty. The server has already
 * put the draft root there (`productturn.ts`), so the composer's job is to hand
 * the agent that bubble instead of letting it start a root of its own — and,
 * when the product-first turn is armed, to spend the whole turn on the picture
 * and stop. `productTurn: false` is the same handover without the stop.
 */
export function composeFirstUtterance(
  store: GraphStore,
  text: string,
  opts: { productTurn: boolean },
): string {
  const said = `User said: "${text}"`;
  const draft = store.node(DRAFT_ROOT_ID);
  const handover =
    `The canvas was empty, so the words below have already been sketched onto it: one product ` +
    `bubble, id \`${DRAFT_ROOT_ID}\`, labelled "${draft?.label ?? DRAFT_ROOT_LABEL}", with the user's own ` +
    `sentence as its promise. Upsert THAT id with the real name — never a second root bubble.`;

  if (!opts.productTurn) return [handover, said, REMINDER].join("\n\n");

  return [
    "<canvas-steering>",
    handover,
    "",
    "This turn is the product picture and nothing else:",
    `1. Upsert \`${DRAFT_ROOT_ID}\` with the product's real name as its label and the one-sentence promise of the whole thing as its summary (keep \`layer: "product"\` and \`parentId: null\`).`,
    `2. Give it 3 to 5 capability bubbles as children (\`layer: "product"\`, \`parentId: "${DRAFT_ROOT_ID}"\`), each one a promise to a person, in plain words.`,
    "3. Then stop and let the user look. No file reads and no file writes this turn, no build bubbles, no `realizes` — an op below the product layer comes back rejected with `product/first`.",
    "",
    'Finish with one short sentence in the panel inviting the user to correct the picture or say "build it".',
    said,
    "</canvas-steering>",
  ].join("\n");
}
