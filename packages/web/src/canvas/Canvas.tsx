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
import { selectLayer } from "../layer.ts";
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

/** the steering bar owns the bottom of the stage; overlays sit above it */
const MINIMAP_LIFT = 92;
const MINIMAP_W = 176;
const MINIMAP_H = 116;

/** the minimap receives generic nodes, so read the mirrored phase by narrowing */
function minimapClass(node: Node): string {
  const phase = node.data.phase;
  return typeof phase === "string" ? `mm-${phase}` : "mm-reality";
}

export function Canvas() {
  const doc = useApp((state) => state.doc);
  const selection = useApp((state) => state.selection);
  const activity = useApp((state) => state.activity);
  const showReality = useApp((state) => state.showReality);
  const focus = useApp((state) => state.focus);
  const select = useApp((state) => state.select);
  const setFocus = useApp((state) => state.setFocus);

  // one layer, chosen before layout runs: elk only ever sees the siblings on
  // screen, which is why the layouts stay small and legible however deep the
  // decomposition goes
  const layer = useMemo(() => selectLayer({ doc, focus, activity }), [doc, focus, activity]);
  // quantised so a few pixels of resize never re-run layout, while a genuinely
  // different window shape does: spread arrangements follow the aspect so a tall
  // window gets a tall triangle and a wide one a wide triangle
  const paneWidth = useStore((state) => state.width);
  const paneHeight = useStore((state) => state.height);
  const aspect = paneHeight > 0 ? Math.round((paneWidth / paneHeight) * 10) / 10 : 1.4;
  const input = useMemo(() => ({ layer, reality: doc.reality, aspect }), [layer, doc.reality, aspect]);

  // with the reality column hidden the authored bubbles are the whole picture;
  // with it shown, framing everything costs almost no zoom because the
  // composition is height-constrained
  const scope = useMemo(
    () => (showReality ? undefined : layer.nodes.map((entry) => entry.node.id)),
    [showReality, layer.nodes],
  );

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
    maxZoom: MAX_ZOOM,
  });

  const { nodes, edges } = useMemo(
    () => buildCanvas({ layer, reality: doc.reality, boxes, selection, showReality, entering, leaving }),
    [layer, doc.reality, boxes, selection, showReality, entering, leaving],
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
        if (node.type !== "bubble") return;
        select({ kind: "node", id: node.id });
      }}
      onNodeDoubleClick={(_event, node) => {
        if (node.type !== "bubble") return;
        const children = node.data.childCount;
        if (typeof children !== "number" || children === 0) return;
        setFocus(node.id);
      }}
      onEdgeClick={(_event, edge) => {
        // Only a rendered edge that stands for exactly one document relation is
        // a referent. Reality edges and lifted bundles carry a null edgeId, and
        // the bundle's own label button handles drilling instead.
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
