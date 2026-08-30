import { Handle, Position, useStore, type NodeProps } from "@xyflow/react";
import { useApp } from "../store.ts";
import { useVoiceHold, type HoldHandlers } from "../wispr.ts";
import type { BubbleNodeType } from "./types.ts";

/** semantic-zoom tiers: what a bubble is worth saying at this scale */
type Tier = "min" | "compact" | "full";

const TIER_COMPACT_BELOW = 0.45;
const TIER_MIN_BELOW = 0.38;

/** comparison marks, in the same words the comparison legend uses */
const DELTA_WORD: Record<string, string> = { added: "new", changed: "changed", removed: "gone" };

/** press-and-hold dictation is meaningless on a past version, so it is unwired there */
const NO_HOLD: Partial<HoldHandlers> = {};

export function BubbleNode({ data }: NodeProps<BubbleNodeType>) {
  const tier = useStore((state): Tier => {
    const zoom = state.transform[2];
    if (zoom < TIER_MIN_BELOW) return "min";
    if (zoom < TIER_COMPACT_BELOW) return "compact";
    return "full";
  });
  const setFocus = useApp((state) => state.setFocus);
  const { holding, handlers } = useVoiceHold();

  const {
    node,
    active,
    activeInside,
    drift,
    driftInside,
    failedInside,
    isSelected,
    childCount,
    motion,
    deltaStatus,
    deltaNotes,
  } = data;
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

  const comparing = deltaStatus !== null;
  const deltaWord = deltaStatus === null ? undefined : DELTA_WORD[deltaStatus];
  /** the loudest thing about a changed bubble is what changed, not its promise */
  const changeNote = deltaNotes[0];
  const tip = comparing
    ? [node.summary, ...deltaNotes].join("\n")
    : tier === "min"
      ? node.summary
      : undefined;
  /** in a comparison the mark is the first thing said out loud, phase second */
  const spoken = comparing
    ? `${deltaWord ?? "unchanged"}: ${node.label}, ${node.phase} — ${node.summary}`
    : `${node.phase} ${node.label}: ${node.summary}`;

  return (
    <div
      className="bubble"
      role={comparing ? "group" : "button"}
      tabIndex={-1}
      aria-label={spoken}
      // the promise is always reachable, even where the card has no room for it
      title={tip}
      data-phase={node.phase}
      data-selected={isSelected}
      data-active={active || liveInside}
      data-active-inside={liveInside && !active}
      data-drift={hasDrift}
      data-drift-inside={!hasDrift && driftInside > 0}
      data-holding={holding}
      data-tier={tier}
      data-delta={deltaStatus ?? undefined}
      data-motion={motion}
      {...(comparing ? NO_HOLD : handlers)}
    >
      {active || liveInside ? <span className="activity-ring" /> : null}

      <div className="bubble-head">
        <span className="phase-dot" />
        <span className="bubble-label">{node.label}</span>
        {deltaWord === undefined ? null : <span className="badge badge-delta">{deltaWord}</span>}
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

      {/* one volatile line, spent on whichever of the two matters here: what the
          agent is doing now on the live canvas, what moved in a comparison */}
      {tier === "min" ? null : comparing && changeNote !== undefined ? (
        <p className="bubble-summary bubble-change">{changeNote}</p>
      ) : nowLine !== null ? (
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
