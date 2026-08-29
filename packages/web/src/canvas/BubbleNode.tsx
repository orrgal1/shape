import { Handle, Position, useStore, type NodeProps } from "@xyflow/react";
import { useApp } from "../store.ts";
import { useVoiceHold } from "../wispr.ts";
import type { BubbleNodeType } from "./types.ts";

/** semantic-zoom tiers: what a bubble is worth saying at this scale */
type Tier = "min" | "compact" | "full";

const TIER_COMPACT_BELOW = 0.45;
const TIER_MIN_BELOW = 0.38;

export function BubbleNode({ data }: NodeProps<BubbleNodeType>) {
  const tier = useStore((state): Tier => {
    const zoom = state.transform[2];
    if (zoom < TIER_MIN_BELOW) return "min";
    if (zoom < TIER_COMPACT_BELOW) return "compact";
    return "full";
  });
  const setFocus = useApp((state) => state.setFocus);
  const { holding, handlers } = useVoiceHold();

  const { node, active, activeInside, drift, driftInside, failedInside, isSelected, childCount, motion } = data;
  const liveInside = activeInside.length > 0;
  const hasDrift = drift.length > 0;
  const detail = tier === "full";
  const codeRef = node.codeRefs?.[0];
  const role = node.modelRole;

  // what the bubble says about "now": its own status, or the status of whatever
  // hidden descendant the agent is actually inside
  const inside = activeInside[0];
  const nowLine =
    active && node.status !== undefined
      ? node.status
      : inside !== undefined
        ? `${inside.label}${inside.status === null ? "" : ` — ${inside.status}`}`
        : null;

  return (
    <div
      className="bubble"
      role="button"
      tabIndex={-1}
      aria-label={`${node.phase} ${node.label}: ${node.summary}`}
      // the promise is always reachable, even where the card has no room for it
      title={tier === "min" ? node.summary : undefined}
      data-phase={node.phase}
      data-selected={isSelected}
      data-active={active || liveInside}
      data-active-inside={liveInside && !active}
      data-drift={hasDrift}
      data-drift-inside={!hasDrift && driftInside > 0}
      data-holding={holding}
      data-tier={tier}
      data-motion={motion}
      {...handlers}
    >
      {active || liveInside ? <span className="activity-ring" /> : null}

      <div className="bubble-head">
        <span className="phase-dot" />
        <span className="bubble-label">{node.label}</span>
        {detail && (hasDrift || driftInside > 0) ? (
          <button
            type="button"
            className="drift-flag nodrag nopan"
            data-inside={!hasDrift}
            aria-label={`${drift.length + driftInside} drift notes`}
          >
            drift {drift.length + driftInside}
            <span className="drift-tip" role="tooltip">
              <span className="drift-tip-title">intent vs code</span>
              {hasDrift ? (
                <ul>
                  {drift.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : null}
              {driftInside > 0 ? (
                <span className="drift-tip-inside">
                  {driftInside} more {driftInside === 1 ? "note" : "notes"} on bubbles inside this one.
                </span>
              ) : null}
            </span>
          </button>
        ) : null}
      </div>

      {tier === "min" ? null : nowLine !== null ? (
        <p className="bubble-summary bubble-status" data-inside={!active}>
          {nowLine}
        </p>
      ) : (
        <p className="bubble-summary">{node.summary}</p>
      )}

      <div className="bubble-foot">
        <span className="bubble-phase">{node.phase}</span>
        {detail && failedInside > 0 ? <span className="badge badge-failed">{failedInside} failed inside</span> : null}
        {detail && role !== undefined ? <span className="badge badge-role">{role}</span> : null}
        {detail && codeRef !== undefined ? <span className="bubble-refs">{codeRef}</span> : null}
      </div>

      {/* drill affordance: the only way in, alongside double-click. Single click
          stays selection so steering never changes what you are looking at. */}
      {childCount > 0 ? (
        <button
          type="button"
          className="drill-chip nodrag nopan"
          title={`open ${node.label} — ${childCount} inside`}
          onClick={(event) => {
            event.stopPropagation();
            setFocus(node.id);
          }}
        >
          {tier === "min" ? null : `${childCount} inside`} <span className="drill-caret">›</span>
        </button>
      ) : null}

      {holding ? (
        <span className="hold-bar" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : null}

      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}
