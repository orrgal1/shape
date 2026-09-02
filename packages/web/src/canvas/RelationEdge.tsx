import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { useApp } from "../store.ts";
import { cubicControls, cubicNormal, cubicPoint, pathOf } from "./geometry.ts";
import type { RelEdge } from "./types.ts";

/** kind -> arrow marker; relations without direction get no head */
const MARKER_BY_KIND: Record<string, string | undefined> = {
  depends: "url(#arrow-depends)",
  dataflow: "url(#arrow-dataflow)",
};

/** what a marked line says about itself in a comparison */
const DELTA_LINE: Record<string, string> = {
  added: "new relation",
  changed: "this relation changed",
  removed: "relation gone",
  same: "unchanged in this comparison",
};

/**
 * The stroke is a quadratic between anchors chosen by canvas/geometry.ts, bowed
 * by the `bend` that pass verified clears every bubble it merely passes. React
 * Flow's own `sourceX/sourceY` are deliberately ignored: they come from handle
 * measurement, and using them would let the drawn curve drift away from the
 * geometry the clearance and label placement were computed against.
 */
export function RelationEdge({ id, data }: EdgeProps<RelEdge>) {
  const select = useApp((state) => state.select);
  const setFocus = useApp((state) => state.setFocus);

  const geom = data?.geom;
  if (geom === undefined) return null;

  const a = { x: geom.ax, y: geom.ay };
  const b = { x: geom.bx, y: geom.by };
  const path = pathOf(a, b, geom.bow);
  const [c1, c2] = cubicControls(a, b, geom.bow);

  const on = cubicPoint(a, c1, c2, b, geom.labelT);
  const normal = cubicNormal(a, c1, c2, b, geom.labelT);
  const labelX = on.x + normal.x * geom.labelOff;
  const labelY = on.y + normal.y * geom.labelOff;

  const kind = data?.kind ?? null;
  const edgeId = data?.edgeId ?? null;
  /** several relations collapsed into this line: no single referent to offer */
  const bundle = kind !== null && edgeId === null;
  const lifted = data?.lifted === true;
  const count = data?.count ?? 0;
  const drillId = data?.drillId ?? null;
  const deltaStatus = data?.deltaStatus ?? null;

  // A line in a comparison is not a steering target and cannot be drilled, so it
  // spends its tooltip saying what happened to it instead of how to act on it.
  let tip: string;
  if (deltaStatus !== null) {
    tip = [DELTA_LINE[deltaStatus] ?? "", ...(data?.deltaNotes ?? [])].join("\n");
  } else if (bundle) {
    tip = `${count} relations below this level — click to drill in:\n${(data?.parts ?? []).join("\n")}`;
  } else if (lifted) {
    tip = `drawn one level up — click to steer the real relation:\n${(data?.parts ?? []).join("\n")}`;
  } else {
    // the pill may have been narrowed to fit, so the words live here too
    const label = data?.label ?? "";
    tip = label.length > 0 ? `${label}\n${kind} relation — click to steer it` : `${kind} relation — click to steer it`;
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className="rel-path"
        interactionWidth={kind === null ? 0 : 26}
        markerEnd={kind === null ? undefined : MARKER_BY_KIND[kind]}
      />
      {kind === null ? null : (
        <EdgeLabelRenderer>
          {/* a hairline from the curve to the pill whenever the pill had to step
              aside, so a label is never reading as unattached */}
          {geom.labelOff === 0 ? null : (
            <span
              className="rel-tether"
              style={{
                transform: `translate(-50%, -50%) translate(${(on.x + labelX) / 2}px, ${(on.y + labelY) / 2}px) rotate(${Math.atan2(labelY - on.y, labelX - on.x)}rad)`,
                width: Math.abs(geom.labelOff),
              }}
            />
          )}
          <button
            type="button"
            className="rel-label nodrag nopan"
            data-selected={data?.isSelected === true}
            data-bundle={bundle}
            data-delta={deltaStatus ?? undefined}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              maxWidth: geom.labelMax,
              pointerEvents: "all",
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (deltaStatus !== null) return;
              // A bundle is not one relation, so it cannot be a referent. Drill
              // into its source instead — that is where the real edges live.
              if (edgeId !== null) {
                select({ kind: "edge", id: edgeId });
                return;
              }
              if (drillId !== null) setFocus(drillId);
            }}
            title={tip}
          >
            <span className="rel-kind" aria-hidden="true" />
            {bundle ? (
              <>
                <span className="rel-text rel-text-empty">{kind}</span>
                <span className="rel-count">{count}</span>
              </>
            ) : data?.label !== undefined && data.label.length > 0 ? (
              <span className="rel-text">{data.label}</span>
            ) : (
              <span className="rel-text rel-text-empty">{kind}</span>
            )}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
