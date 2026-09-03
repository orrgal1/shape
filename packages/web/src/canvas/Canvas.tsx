import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useStore,

  type EdgeTypes,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";
import { buildDeltaView } from "../deltaView.ts";
import { selectLayer, selectReality } from "../layer.ts";
import { STRIP_ID } from "../layout.ts";
import { useApp } from "../store.ts";
import { BubbleNode } from "./BubbleNode.tsx";
import { GhostNode, StripNode } from "./GhostNode.tsx";
import { RelationEdge } from "./RelationEdge.tsx";
import { buildCanvas } from "./build.ts";
import { useMotion } from "./motion.ts";

const NODE_TYPES: NodeTypes = { bubble: BubbleNode, ghost: GhostNode, strip: StripNode };
const EDGE_TYPES: EdgeTypes = { rel: RelationEdge };

/** leaves room for the header, the steering bar and the corner overlays */
const FIT_PADDING = { top: "76px", right: "44px", bottom: "124px", left: "44px" } as const;

/** zoom bounds shared by the pane and the framing maths */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.1;
/** one bubble on the layer may fill the page rather than sit small in the middle */
const SOLO_MAX_ZOOM = 1.8;

/** the steering bar owns the bottom of the stage; overlays sit above it */
const MINIMAP_LIFT = 92;
const MINIMAP_W = 176;
const MINIMAP_H = 116;

/**
 * The minimap receives generic nodes, so the mirrored fields are read by
 * narrowing. A comparison mark wins over the phase: the small map has to agree
 * with the big one about which shapes are the interesting ones.
 */
function minimapClass(node: Node): string {
  const delta = node.data.deltaStatus;
  if (typeof delta === "string") return `mm-delta-${delta}`;
  const phase = node.data.phase;
  return typeof phase === "string" ? `mm-${phase}` : "mm-reality";
}

/** stable empty snapshot: a fresh Set per render would re-run layout forever */
const NO_ACTIVITY: ReadonlySet<string> = new Set<string>();

export function Canvas() {
  const liveDoc = useApp((state) => state.doc);
  const liveActivity = useApp((state) => state.activity);
  const liveShowReality = useApp((state) => state.showReality);
  const liveFocus = useApp((state) => state.focus);
  const layerView = useApp((state) => state.view);
  const delta = useApp((state) => state.delta);
  const deltaContext = useApp((state) => state.deltaContext);
  const selection = useApp((state) => state.selection);
  const hover = useApp((state) => state.hover);
  const select = useApp((state) => state.select);
  const setHover = useApp((state) => state.setHover);
  const setFocus = useApp((state) => state.setFocus);

  /**
   * A comparison runs through this very pipeline: one flat synthetic document
   * instead of the live one, so layer selection, layout, framing, motion and
   * edge routing are shared rather than reimplemented.
   *
   * Four things are switched off on purpose while it is open. Drill-down: the
   * projection is parentless, so a focus would address nothing and nesting
   * would hide the very change being examined. The fold: a comparison is one
   * flat layer of exactly what changed, and folding four fifths of it away
   * would hide the answer. The reality column: extracted code describes now,
   * not a version that already happened. Activity pulses: nothing is being
   * worked on inside a past version.
   *
   * Live `graph` frames keep updating the store while this is open; they cannot
   * disturb the view, because everything below reads the projection instead.
   */
  const view = useMemo(() => (delta === null ? null : buildDeltaView(delta, deltaContext)), [delta, deltaContext]);
  const comparing = view !== null;
  const doc = view === null ? liveDoc : view.doc;
  const focus = view === null ? liveFocus : null;
  const activity = view === null ? liveActivity : NO_ACTIVITY;
  // the reality column is extracted code, which is the build layer's story: a
  // package strip under a row of capability cards would be answering a question
  // the product layer never asks
  const showReality = view === null && layerView === "build" ? liveShowReality : false;
  const marks = view === null ? null : view.marks;

  // one layer, capped at five bubbles and chosen before layout runs: elk and
  // the hand arrangements only ever see what is on screen, which is why the
  // layouts stay small and legible however deep or wide the decomposition goes.
  // A comparison is read across both layers at once — it is a flat reading of
  // what changed, wherever it changed — so it passes no layer at all.
  const fold = view === null;
  const scopeLayer = view === null ? layerView : null;
  const layer = useMemo(
    () => selectLayer({ doc, focus, activity, layer: scopeLayer, fold }),
    [doc, focus, activity, scopeLayer, fold],
  );
  // a package a bubble already claims is not news; ghosting it anyway is what
  // filled half the canvas on a nine-package project
  const reality = useMemo(() => selectReality(doc), [doc]);
  // quantised so a few pixels of resize never re-run layout, while a genuinely
  // different window shape does: spread arrangements follow the aspect so a tall
  // window gets a tall triangle and a wide one a wide triangle
  const paneWidth = useStore((state) => state.width);
  const paneHeight = useStore((state) => state.height);
  const aspect = paneHeight > 0 ? Math.round((paneWidth / paneHeight) * 10) / 10 : 1.4;
  const input = useMemo(() => ({ layer, reality, aspect }), [layer, reality, aspect]);

  // Framing covers exactly what is drawn. With the reality column hidden — or
  // fully claimed, so there is nothing left to draw — the authored bubbles are
  // the whole picture, and boxes laid out for cards nobody renders must not pull
  // the viewport towards empty space.
  const scope = useMemo(() => {
    const ids = layer.nodes.map((entry) => entry.node.id);
    if (!showReality || reality.nodes.length === 0) return ids;
    return [...ids, STRIP_ID, ...reality.nodes.map((node) => node.id)];
  }, [showReality, layer.nodes, reality.nodes]);

  /**
   * Everything on screen is always framed. The viewport is not a separate
   * animation racing the layout any more: `useMotion` computes the target
   * viewport from the target boxes and interpolates both on one clock, so any
   * content change — drill, up, a bubble the agent added, activity revealing an
   * ancestor, the reality toggle — recentres without a correction jump.
   */
  const { boxes, entering, leaving, swap, setInteracting } = useMotion({
    input,
    scope,
    padding: FIT_PADDING,
    minZoom: MIN_ZOOM,
    maxZoom: layer.nodes.length === 1 ? SOLO_MAX_ZOOM : MAX_ZOOM,
  });

  const { nodes, edges } = useMemo(
    () => buildCanvas({ layer, reality, boxes, selection, hover, showReality, entering, leaving, marks }),
    [layer, reality, boxes, selection, hover, showReality, entering, leaving, marks],
  );

  // the dissolve is applied to the pane, never to node positions: React Flow
  // measures positions to route its edges, so only opacity may be animated here
  useEffect(() => {
    const pane = document.querySelector(".react-flow__viewport");
    if (pane === null) return;
    pane.setAttribute("data-swap", swap);
  }, [swap]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnScroll
      selectionOnDrag={false}
      minZoom={MIN_ZOOM}
      maxZoom={2.4}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_event, node) => {
        // a bubble in a past version is not a steering target
        if (comparing || node.type !== "bubble") return;
        select({ kind: "node", id: node.id });
      }}
      onNodeDoubleClick={(_event, node) => {
        if (comparing || node.type !== "bubble") return;
        const children = node.data.childCount;
        if (typeof children !== "number" || children === 0) return;
        setFocus(node.id);
      }}
      // Hover is what un-hides a stroke's words: over a bubble, its own
      // relations say what they are; over a stroke, that one does. Nothing here
      // touches layout, so revealing a label never moves anything.
      onNodeMouseEnter={(_event, node) => {
        if (node.type !== "bubble") return;
        setHover({ kind: "node", id: node.id });
      }}
      onNodeMouseLeave={() => setHover(null)}
      onEdgeMouseEnter={(_event, edge) => setHover({ kind: "edge", id: edge.id })}
      onEdgeMouseLeave={() => setHover(null)}
      onEdgeClick={(_event, edge) => {
        // Only a rendered edge that stands for exactly one document relation is
        // a referent. Reality edges and lifted bundles carry a null edgeId, and
        // the bundle's own label button handles drilling instead.
        if (comparing) return;
        const edgeId = edge.data?.edgeId;
        if (typeof edgeId !== "string") return;
        select({ kind: "edge", id: edgeId });
      }}
      onPaneClick={() => select(null)}
      // a null event means the viewport moved programmatically — only a real
      // pointer or wheel gesture should suspend automatic framing
      onMoveStart={(event) => {
        if (event !== null) setInteracting(true);
      }}
      onMoveEnd={(event) => {
        if (event !== null) setInteracting(false);
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="var(--bg-grid)" />
      {/* navigation chrome would only be noise before the first bubble exists */}
      {nodes.length === 0 ? null : (
        <>
          <Controls
            showInteractive={false}
            position="bottom-left"
            style={{ marginBottom: MINIMAP_LIFT }}
            orientation="horizontal"
          />
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            style={{ marginBottom: MINIMAP_LIFT, width: MINIMAP_W, height: MINIMAP_H }}
            nodeClassName={minimapClass}
            nodeStrokeWidth={0}
            nodeBorderRadius={4}
            maskStrokeColor="transparent"
          />
        </>
      )}
    </ReactFlow>
  );
}
