import type { Edge, Node } from "@xyflow/react";
import type { EdgeKind, IntentNode, Phase } from "../../../shared/src/index.ts";
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
  /** direct children, i.e. what drilling in reveals */
  childCount: number;
  descendantCount: number;
  /** entry and exit animation state, driven by the motion choreography */
  motion: "enter" | "leave" | "none";
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
}

export type RelEdge = Edge<RelData, "rel">;

export type CanvasEdge = RelEdge;
