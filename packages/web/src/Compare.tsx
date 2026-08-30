/**
 * Comparing two saved versions of the canvas.
 *
 * The bridge keeps a snapshot of the intent layer per revision. This picks two
 * of them, asks the bridge for the difference, and hands the answer to the
 * canvas, which draws it in place of the live graph. Both halves live here — the
 * picker while the canvas is live, the summary while a comparison is on screen —
 * because they are one control in two states, and only one is ever useful.
 *
 * The word "revision" stays off screen. A person steering by voice is choosing
 * between "12 minutes ago" and "an hour ago"; the version number is a machine
 * address, so it appears where machine addresses appear: small, in monospace.
 */
import { Fragment, useEffect, useState } from "react";
import type { RevisionInfo } from "../../shared/src/index.ts";
import { useDismissable } from "./dismiss.ts";
import { useApp } from "./store.ts";
import { send } from "./ws.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** how long ago, in the words a person would use out loud */
function timeAgo(at: string, now: number): string {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return "unknown time";
  const ago = Math.max(0, now - then);
  if (ago < MINUTE_MS) return "moments ago";
  if (ago < HOUR_MS) {
    const minutes = Math.round(ago / MINUTE_MS);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (ago < DAY_MS) {
    const hours = Math.round(ago / HOUR_MS);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(ago / DAY_MS);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function Picker({ revisions }: { revisions: RevisionInfo[] }) {
  const beginCompare = useApp((state) => state.beginCompare);
  const waiting = useApp((state) => state.compare !== null && state.delta === null);
  const [open, setOpen] = useState(false);
  const menuRef = useDismissable(open, setOpen);
  const [beforePick, setBeforePick] = useState<number | null>(null);
  const [afterPick, setAfterPick] = useState<number | null>(null);

  // Defaults are derived, never synced into state: the list grows while this is
  // mounted, and the useful default — the two newest versions — moves with it. A
  // pick the bridge has since pruned away falls back to the default too.
  const beforeRev = revisions.some((entry) => entry.rev === beforePick)
    ? beforePick
    : (revisions[revisions.length - 2]?.rev ?? null);
  const afterRev = revisions.some((entry) => entry.rev === afterPick)
    ? afterPick
    : (revisions[revisions.length - 1]?.rev ?? null);
  const samePick = beforeRev === null || afterRev === null || beforeRev === afterRev;

  const now = Date.now();
  const ask = (): void => {
    if (beforeRev === null || afterRev === null || beforeRev === afterRev) return;
    // Choosing the later version on the "before" side is a slip, not an intent,
    // so the earlier of the two is always the before side.
    const revA = Math.min(beforeRev, afterRev);
    const revB = Math.max(beforeRev, afterRev);
    beginCompare(revA, revB);
    send({ type: "diff", revA, revB });
    setOpen(false);
  };

  return (
    <div className="cmp" ref={menuRef}>
      <button
        type="button"
        className="toggle cmp-open"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="see what changed between two saved versions of this canvas"
      >
        {waiting ? "working…" : "compare versions"}
        <span className="project-caret">▾</span>
      </button>

      {open ? (
        <div className="project-menu cmp-menu">
          <p className="project-menu-title">compare versions</p>
          <p className="tl-empty">
            Pick an earlier version and a later one. The canvas then shows what changed between them: what is new, what
            changed, and what is gone.
          </p>

          <div className="cmp-grid" role="group" aria-label="versions to compare">
            <span className="cmp-head">before</span>
            <span className="cmp-head">after</span>
            <span className="cmp-head cmp-head-when">saved</span>
            {revisions
              .slice()
              .reverse()
              .map((entry) => {
                const label = timeAgo(entry.at, now);
                return (
                  <Fragment key={entry.rev}>
                    <input
                      type="radio"
                      className="cmp-radio"
                      name="cmp-before"
                      checked={beforeRev === entry.rev}
                      aria-label={`before: ${label}`}
                      onChange={() => setBeforePick(entry.rev)}
                    />
                    <input
                      type="radio"
                      className="cmp-radio"
                      name="cmp-after"
                      checked={afterRev === entry.rev}
                      aria-label={`after: ${label}`}
                      onChange={() => setAfterPick(entry.rev)}
                    />
                    <span className="cmp-when" title={entry.at}>
                      {label}
                      <span className="cmp-rev mono">rev {entry.rev}</span>
                      {entry.rev === revisions[revisions.length - 1]?.rev ? (
                        <span className="project-recent-tag">latest</span>
                      ) : null}
                    </span>
                  </Fragment>
                );
              })}
          </div>

          <div className="cmp-actions">
            <span className="cmp-hint">{samePick ? "Pick two different versions." : null}</span>
            <button type="button" className="btn btn-send" onClick={ask} disabled={samePick || waiting}>
              {waiting ? "Working…" : "Show what changed"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Summary() {
  const delta = useApp((state) => state.delta);
  const revisions = useApp((state) => state.revisions);
  const hasBackdrop = useApp((state) => state.deltaContext !== null);
  const exitCompare = useApp((state) => state.exitCompare);
  if (delta === null) return null;

  const now = Date.now();
  const label = (rev: number): string => {
    const found = revisions.find((entry) => entry.rev === rev);
    return found === undefined ? `rev ${rev}` : timeAgo(found.at, now);
  };

  const added = delta.nodes.added.length + delta.edges.added.length;
  const changed = delta.nodes.changed.length + delta.edges.changed.length;
  const removed = delta.nodes.removed.length + delta.edges.removed.length;
  const quiet = added === 0 && changed === 0 && removed === 0;

  return (
    <div className="cmp-bar" role="status">
      <div className="cmp-bar-row">
        <span className="cmp-kicker">comparing</span>
        <span className="cmp-pair">
          {label(delta.revA)} <span className="cmp-arrow">→</span> {label(delta.revB)}
        </span>
        <button type="button" className="btn cmp-exit" onClick={exitCompare} title="leave the comparison (Esc)">
          Back to now
        </button>
      </div>

      {quiet ? (
        <p className="cmp-note">Nothing changed between these two versions.</p>
      ) : (
        <div className="cmp-counts">
          <span className="cmp-count" data-delta="added" data-zero={added === 0}>
            {added} new
          </span>
          <span className="cmp-count" data-delta="changed" data-zero={changed === 0}>
            {changed} changed
          </span>
          <span className="cmp-count" data-delta="removed" data-zero={removed === 0}>
            {removed} gone
          </span>
        </div>
      )}

      <div className="legend cmp-legend">
        <span className="legend-item cmp-legend-added">
          <i />
          new
        </span>
        <span className="legend-item cmp-legend-changed">
          <i />
          changed
        </span>
        <span className="legend-item cmp-legend-removed">
          <i />
          gone
        </span>
        {hasBackdrop ? (
          <span className="legend-item cmp-legend-same">
            <i />
            unchanged
          </span>
        ) : null}
      </div>

      {/* honesty about the backdrop: without the after side on hand there is
          nothing truthful to recede behind the changes */}
      {hasBackdrop ? null : (
        <p className="cmp-note">Only what changed is drawn — the canvas has moved on since the later version.</p>
      )}
    </div>
  );
}

export function Compare() {
  const revisions = useApp((state) => state.revisions);
  const comparing = useApp((state) => state.delta !== null);
  const exitCompare = useApp((state) => state.exitCompare);

  // Escape already means "drop what you are holding" on this canvas; while a
  // comparison is open, the thing being held is the comparison itself
  useEffect(() => {
    if (!comparing) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") exitCompare();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [comparing, exitCompare]);

  if (comparing) return <Summary />;
  // one saved version is nothing to compare against
  if (revisions.length < 2) return null;
  return <Picker revisions={revisions} />;
}
