import type { Edge, Node } from "@xyflow/react";
import type { EdgeKind, IntentNode, Layer, Phase } from "../../../shared/src/index.ts";
import type { DeltaStatus } from "../deltaView.ts";
import type { InsideRef } from "../layer.ts";
import type { EdgeGeom } from "./geometry.ts";

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
  /**
   * Which layer the bubble is drawn in. A capability card and a component card
   * share their geometry and differ in what they are allowed to say: a
   * capability has no code line, a component has no "built by".
   */
  layer: Layer;
  /** product bubbles: build bubbles that make this capability real */
  realizerCount: number;
  /** build bubbles: capabilities this bubble (or an ancestor) serves */
  serveCount: number;
  /** a capability past `concept` that nothing on the build side answers */
  unrealized: boolean;
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

export interface GhostData extends Record<string, unknown> {
  phase: "reality";
  label: string;
  dir: string;
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
