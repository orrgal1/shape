import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GhostNodeType, StripNodeType } from "./types.ts";

/** a package the extractor found in the repo: read-only, deliberately quiet */
export function GhostNode({ data }: NodeProps<GhostNodeType>) {
  return (
    <div className="ghost" aria-hidden="true">
      <span className="ghost-label">{data.label}</span>
      <span className="ghost-dir">{data.dir}</span>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

/** the caption that separates authored intent from extracted reality */
export function StripNode({ data }: NodeProps<StripNodeType>) {
  return (
    <div className="strip-note" aria-hidden="true">
      <span className="strip-note-label">{data.caption}</span>
      <span className="strip-note-rule" />
    </div>
  );
}
