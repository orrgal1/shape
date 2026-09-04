import { Handle, Position, type NodeProps } from "@xyflow/react";
import { KindSigil, SymbolSigil } from "./kind.tsx";
import type { GhostNodeType, StripNodeType } from "./types.ts";

/**
 * Something the extractor found that the canvas has not accounted for: a
 * package, a piece of infrastructure, or a class inside the bubble you are
 * standing in. Read-only and deliberately quiet — a ghost states a fact about
 * the code and offers nothing to click, because the way to act on it is to put
 * a bubble there.
 */
export function GhostNode({ data }: NodeProps<GhostNodeType>) {
  const sigil = data.sigil;
  return (
    <div className="ghost" aria-hidden="true">
      <span className="ghost-label">
        {sigil === null ? null : sigil === "class" || sigil === "function" ? (
          <SymbolSigil kind={sigil} />
        ) : (
          <KindSigil kind={sigil} />
        )}
        <span className="ghost-name">{data.label}</span>
      </span>
      <span className="ghost-note" data-mono={data.mono}>
        {data.note}
      </span>
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
