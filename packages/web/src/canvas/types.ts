import type { Edge, Node } from "@xyflow/react";
import type { EdgeKind, IntentNode, Layer, LinkGap, Phase } from "../../../shared/src/index.ts";
import type { DeltaStatus } from "../deltaView.ts";
import type { GhostSigil, InsideRef, Shield } from "../layer.ts";
import type { EdgeGeom } from "./geometry.ts";

/**
 * One variation that holds this bubble, drawn as a small dot under the card.
 * The colour slot is the variation's own and stable across every bubble, so a
 * reader learns "the green pip is the reminders branch" once.
 */
export interface BranchPip {
  worktree: string;
  /** what a person calls it: the branch name */
  branch: string;
  /** this variation's copy of the bubble says something else */
  differs: boolean;
  /** colour slot, `--wt-N` in the stylesheet */
  tone: number;
  /** the copy that is the one drawn on the card */
  primary: boolean;
}

export interface BubbleData extends Record<string, unknown> {
  node: IntentNode;
  /** mirrored out of `node` so the minimap can colour without narrowing a union */
  phase: Phase;
  /** the agent is working in this bubble itself */
  active: boolean;
  /** the agent is working in something hidden underneath it */
  activeInside: InsideRef[];
  drift: readonly string[];
  /** drift notes on hidden descendants: a subdued version of the same warning */
  driftInside: number;
  failedInside: number;
  /**
   * Which variations hold this bubble, or empty when one variation is on screen
   * — a canvas that is not merging anything has nothing to say about where a
   * bubble also lives.
   */
  pips: readonly BranchPip[];
  /**
   * Colour slots of the variations working inside this bubble right now: one
   * ring per variation, so two branches touching the same part read as two.
   * Empty with a single variation on screen, where the ring is the plain one.
   */
  rings: readonly number[];
  isSelected: boolean;
  /**
   * The fold: one bubble standing for the parts a layer had no room for. It has
   * no document identity, so it is not a steering referent, and its drill
   * affordance says "open" rather than counting children.
   */
  isMore: boolean;
  /** direct children, i.e. what drilling in reveals */
  childCount: number;
  descendantCount: number;
  /** alone on its layer: the card is wide and says its whole promise */
  solo: boolean;
  /** under the lens: the card is grown to say its whole promise and drawn above its neighbours */
  lens: boolean;
  /**
   * Which layer the bubble is drawn in. The four cards share their geometry and
   * differ in what they are allowed to say: a capability has no code line, a
   * component has no "built by", a verification says what it attests.
   */
  layer: Layer;
  /** product bubbles: build bubbles that make this capability real */
  realizerCount: number;
  /** build bubbles: capabilities this bubble (or an ancestor) serves */
  serveCount: number;
  /** infra bubbles: build bubbles that run on this piece of infrastructure */
  hostCount: number;
  /** correctness bubbles: build bubbles this verification attests */
  verifyCount: number;
  /** build bubbles: correctness bubbles that cover this bubble (or an ancestor) */
  coverCount: number;
  /**
   * Whether anything attests this bubble, or null where the question is not
   * asked — infrastructure, a verification itself, a fold, or a capability with
   * nothing behind it yet.
   */
  shield: Shield | null;
  /** build leaves: classes and functions inside them that no bubble claims */
  symbolCount: number;
  /**
   * What this bubble should be connected to across the layers and is not, in
   * `linkGapsOf`'s order. The card marks it quietly — a bubble nothing points
   * at is a fact about the graph, not an alarm — and says each one out loud in
   * its label. Empty on a fold and in a comparison.
   */
  gaps: readonly LinkGap[];
  /** a capability past `concept` that nothing on the build side answers */
  unrealized: boolean;
  /**
   * The agent is working and has not said where yet, and this is the bubble the
   * reader is looking at — so it breathes rather than the canvas sitting still.
   */
  thinking: boolean;
  /**
   * The agent is working and has said nothing about where — the same gap
   * `thinking` answers on one card, carried by every bubble on the layer as a
   * faint staggered wash so the whole canvas reads as alive rather than one
   * card doing all the breathing.
   */
  pondering: boolean;
  /** position on the layer, which is what staggers the pondering wash */
  order: number;
  /** entry and exit animation state, driven by the motion choreography */
  motion: "enter" | "leave" | "none";
  /**
   * Comparison view only: which side of the comparison this bubble is on, or
   * null when the canvas is live. It overrides the phase hue while set — in a
   * comparison, what moved has to read before what lifecycle stage it is in.
   */
  deltaStatus: DeltaStatus | null;
  /** plain-English lines about a changed bubble, for its tooltip */
  deltaNotes: readonly string[];
}

export type BubbleNodeType = Node<BubbleData, "bubble">;

/**
 * One card in the code-derived column: a package, a piece of infrastructure or
 * a class the code holds. Read-only in every reading — a ghost is a fact about
 * the code, and the way to act on it is to put a bubble there.
 */
export interface GhostData extends Record<string, unknown> {
  phase: "reality";
  label: string;
  /** the dim second line: a directory, a file and line, or one sentence */
  note: string;
  /** the note is a path, so it is set in mono */
  mono: boolean;
  sigil: GhostSigil | null;
}

export type GhostNodeType = Node<GhostData, "ghost">;

export interface StripData extends Record<string, unknown> {
  phase: "reality";
  caption: string;
}

export type StripNodeType = Node<StripData, "strip">;

export type CanvasNode = BubbleNodeType | GhostNodeType | StripNodeType;

export interface RelData extends Record<string, unknown> {
  /** null for reality edges: derived, not authored, and not steerable */
  kind: EdgeKind | null;
  label: string;
  /**
   * Whether the words are on screen. Every stroke keeps its label in the DOM so
   * it can fade, but a layer of labelled lines is unreadable: they show for the
   * line under the pointer, for the lines of the bubble under the pointer, and
   * for the lines of the selected bubble. A bundle's count badge is not a label
   * and stays visible regardless.
   */
  labelShown: boolean;
  isSelected: boolean;
  /**
   * Anchors, bow and label position, all computed together in canvas/geometry.ts
   * so the label always sits on the stroke the renderer actually draws.
   */
  geom: EdgeGeom;
  /**
   * The document relation this line stands for, or null when several relations
   * collapse into it. Null means the line is not a legitimate steering referent
   * and must not offer to be one.
   */
  edgeId: string | null;
  /** document relations collapsed into this line; 1 unless it is a bundle */
  count: number;
  /** true when drawn between bubbles that are not the relation's real endpoints */
  lifted: boolean;
  /**
   * Which end of this line the agent is working in. A line with a live end
   * carries a dash flow — source to target, which is the direction the
   * relation itself reads in — so the graph shows work travelling rather than
   * sitting in one card.
   */
  live: "none" | "source" | "target" | "both";
  /**
   * Colour slot of the variation working in the TARGET bubble, or null when the
   * work is not arriving here. A line into the bubble the agent is inside
   * glows in that variation's own colour, so two branches working at once stay
   * two.
   */
  tone: number | null;
  /** one line per collapsed relation, for the tooltip */
  parts: string[];
  /** drill target when a bundle is clicked: the source side of the bundle */
  drillId: string | null;
  /** comparison view only: which side of the comparison this line is on */
  deltaStatus: DeltaStatus | null;
  /** plain-English lines about a changed relation, for its tooltip */
  deltaNotes: readonly string[];
}

export type RelEdge = Edge<RelData, "rel">;

export type CanvasEdge = RelEdge;
