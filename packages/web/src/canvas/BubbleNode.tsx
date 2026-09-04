import { Handle, Position, useStore, type NodeProps } from "@xyflow/react";
import { useRef } from "react";
import type { LinkGap } from "../../../shared/src/index.ts";
import { useApp } from "../store.ts";
import { CapabilitySigil, KindSigil, VerifyShield, resolveKind } from "./kind.tsx";
import type { BubbleNodeType } from "./types.ts";

/** semantic-zoom tiers: what a bubble is worth saying at this scale */
type Tier = "min" | "compact" | "full";

const TIER_COMPACT_BELOW = 0.45;
const TIER_MIN_BELOW = 0.38;

/** comparison marks, in the same words the comparison legend uses */
const DELTA_WORD: Record<string, string> = { added: "new", changed: "changed", removed: "gone" };
/**
 * The cross-layer silences in plain English (user decision 2026-09-04:
 * connection is the default, so a bubble nothing on another layer points at
 * says so rather than waiting to be noticed). `unrealized` and `unattested`
 * are absent on purpose — the sentence below already says both, once as the
 * loud claim about a promise and once as what the hollow shield means.
 */
const GAP_SPOKEN: Partial<Record<LinkGap, string>> = {
  unserved: "no capability says what this is for yet",
  unhosted: "nothing on the infra side runs this yet",
  "hosts-nothing": "runs nothing on the build side yet",
  "attests-nothing": "attests nothing on the build side yet",
};
/**
 * Two rings per lit variation, the second one delayed: a single pulse reads as
 * a blip, two overlapping ones read as a pulse that keeps going. The array is
 * module-level so the render allocates nothing per bubble per frame.
 */
const RING_ECHO: readonly boolean[] = [false, true];
/** the halo of a canvas showing one variation: no branch colour to carry */
const PLAIN_HALO: readonly (number | null)[] = [null];
const NO_HALO: readonly (number | null)[] = [];

export function BubbleNode({ data }: NodeProps<BubbleNodeType>) {
  const tier = useStore((state): Tier => {
    const zoom = state.transform[2];
    if (zoom < TIER_MIN_BELOW) return "min";
    if (zoom < TIER_COMPACT_BELOW) return "compact";
    return "full";
  });
  const setFocus = useApp((state) => state.setFocus);
  const drillRealizers = useApp((state) => state.drillRealizers);
  const drillHosts = useApp((state) => state.drillHosts);
  const drillVerified = useApp((state) => state.drillVerified);
  const drillCovering = useApp((state) => state.drillCovering);
  const drillServed = useApp((state) => state.drillServed);

  const {
    node,
    active,
    activeInside,
    drift,
    driftInside,
    failedInside,
    pips,
    rings,
    isSelected,
    isMore,
    childCount,
    solo,
    lens,
    layer,
    realizerCount,
    serveCount,
    hostCount,
    verifyCount,
    coverCount,
    shield,
    symbolCount,
    gaps,
    unrealized,
    thinking,
    pondering,
    order,
    motion,
    deltaStatus,
    deltaNotes,
  } = data;
  const liveInside = activeInside.length > 0;
  /**
   * Rings to draw around the card: one pair per variation working in here, or
   * one pair in the bubble's own accent when a single variation is on screen.
   * Nothing at all when no work is in here — a still card is the honest
   * drawing of a part nobody is touching.
   */
  const halo = rings.length > 0 ? rings : active || liveInside ? PLAIN_HALO : NO_HALO;
  /**
   * A phase change is the one thing a card can say about itself that deserves
   * to be noticed, so the dot ripples when it happens. React keeps the same DOM
   * node across re-renders, and a CSS animation only restarts on a remount, so
   * the count below is what gives the dot a new key.
   */
  const seenPhase = useRef(node.phase);
  const ripples = useRef(0);
  if (seenPhase.current !== node.phase) {
    seenPhase.current = node.phase;
    ripples.current += 1;
  }
  const hasDrift = drift.length > 0;
  const detail = tier === "full";
  const product = layer === "product";
  const infra = layer === "infra";
  const verifies = layer === "correctness";
  const build = layer === "build";
  // the one top-level capability is the product itself: the bubble the whole
  // graph starts from, so it says so and counts capabilities, not parts
  const isRoot = product && !isMore && node.parentId === null;
  // a capability points at code only through the build bubbles that realize it,
  // so a path on the card would be claiming something it does not own
  const codeRef = product ? undefined : node.codeRefs?.[0];
  const role = node.modelRole;
  // The fold is not a part, so it carries no component symbol of its own; a
  // capability is not a part either, and says what it is with one sigil for
  // all. An infra or correctness bubble is the opposite case: its kind IS what
  // it is — a database, a pipeline, a test suite, a smoke run — so it always
  // shows one.
  const kind = isMore || product ? null : resolveKind(node);
  // what drilling in reveals: bubbles somebody wrote, or — for a leaf — the
  // classes and functions the code under it holds
  const insideCount = childCount > 0 ? childCount : symbolCount;
  const mechanical = childCount === 0 && symbolCount > 0;

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
  /**
   * Which other variations hold this bubble, in words: the pips are colour, and
   * colour is not something a screen reader can hand over.
   */
  const alsoOn =
    pips.length < 2
      ? ""
      : ` — ${pips
          .filter((pip) => !pip.primary)
          .map((pip) => `${pip.differs ? "differs on" : "also on"} ${pip.branch}`)
          .join(", ")}`;
  /**
   * The cross-layer silences the sentence does not already carry, in
   * `linkGapsOf`'s order so the card and the side panel list them the same way.
   * The marks on the frame are colour and shape; neither is something a screen
   * reader can hand over.
   */
  let gapWords = "";
  for (const gap of gaps) {
    const said = GAP_SPOKEN[gap];
    if (said !== undefined) gapWords += ` — ${said}`;
  }
  /** in a comparison the mark is the first thing said out loud, phase second */
  const spoken = comparing
    ? `${deltaWord ?? "unchanged"}: ${node.label}, ${node.phase} — ${node.summary}`
    : `${product ? "capability" : node.phase} ${node.label}: ${node.summary}${
        unrealized ? " — nothing on the build side makes this real yet" : ""
      }${shield === "unverified" ? " — nothing attests this yet" : ""}${gapWords}${alsoOn}`;

  return (
    <div
      className="bubble"
      role={comparing ? "group" : "button"}
      tabIndex={-1}
      aria-label={spoken}
      // the promise is always reachable, even where the card has no room for it
      title={tip}
      data-phase={node.phase}
      data-layer={layer}
      data-root={isRoot}
      data-solo={solo}
      data-lens={lens}
      // in a comparison what moved is the whole story; a second loud claim
      // about the build side would answer a question nobody asked
      data-unrealized={unrealized && !comparing}
      // and the quieter half of the same claim: everything else this bubble
      // should have been connected to across the layers and is not
      data-gaps={gaps.length === 0 || comparing ? undefined : gaps.join(" ")}
      data-kind={kind ?? undefined}
      data-more={isMore}
      data-selected={isSelected}
      data-active={active || liveInside}
      data-active-inside={liveInside && !active}
      data-drift={hasDrift}
      data-drift-inside={!hasDrift && driftInside > 0}
      data-tier={tier}
      data-delta={deltaStatus ?? undefined}
      data-thinking={thinking}
      // the whole layer washes gently while the agent is working and has not
      // said where; the fold is a wrapper, not a place, so it sits it out
      data-pondering={pondering && !isMore}
      data-motion={motion}
      style={{ ["--order" as string]: String(order) }}
    >
      {/* Two rings per variation working in here, in that variation's colour,
          the second one delayed: one pulse reads as a blip, two overlapping
          read as something that keeps going. With a single variation on screen
          there is nothing to tell apart and the pair is the plain one. */}
      {halo.map((tone, index) =>
        RING_ECHO.map((echo) => (
          <span
            key={`${tone ?? "plain"}:${String(echo)}`}
            className={`activity-ring${tone === null ? "" : " activity-ring-branch"}${echo ? " activity-ring-echo" : ""}`}
            style={{
              ["--ring-delay" as string]: `${index * 320 + (echo ? 900 : 0)}ms`,
              ...(tone === null ? {} : { ["--wt" as string]: `var(--wt-${tone})` }),
            }}
          />
        )),
      )}

      {/* A bubble that just landed sends one ring outward as it rises, so a new
          part reads as arriving rather than as having always been there. */}
      {motion === "enter" ? <span className="bubble-ripple" aria-hidden="true" /> : null}

      <div className="bubble-head">
        {/* keyed by how many phase changes this card has seen: a remount is what
            restarts the ripple, and a phase change is the one thing about
            itself a card should insist the reader notices */}
        <span className="phase-dot" key={ripples.current} />
        {product ? <CapabilitySigil /> : kind !== null ? <KindSigil kind={kind} /> : null}
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

      {/* One volatile line, spent on whichever of the two matters here: what
          the agent is doing now on the live canvas, what moved in a comparison.
          Each paragraph is keyed by its own words: a remount is what plays the
          animation, so a status that changes slides in as news and a promise
          edited under the reader cross-fades instead of snapping. The words
          themselves stay direct children — the two-line clamp is on this
          element, and a wrapper span would break it. */}
      {tier === "min" ? null : comparing && changeNote !== undefined ? (
        <p className="bubble-summary bubble-change" key={changeNote}>
          {changeNote}
        </p>
      ) : nowLine !== null ? (
        <p className="bubble-summary bubble-status" data-inside={!active} key={nowLine}>
          {nowLine}
        </p>
      ) : (
        <p className="bubble-summary" key={node.summary}>
          {node.summary}
        </p>
      )}

      <div className="bubble-foot">
        <span className="bubble-phase">{node.phase}</span>
        {/* Whether anything attests this bubble, next to the phase label: how
            far along a part is and whether anything backs it are the same kind
            of fact about it, and the head row is already carrying the phase dot
            and the drift flag. In a comparison it is dropped — what moved is
            the whole story there. */}
        {shield !== null && tier !== "min" && !comparing ? (
          <VerifyShield state={shield} of={product ? "capability" : "part"} />
        ) : null}
        {detail && failedInside > 0 ? <span className="badge badge-failed">{failedInside} failed inside</span> : null}
        {detail && role !== undefined ? <span className="badge badge-role">{role}</span> : null}
        {detail && codeRef !== undefined ? <span className="bubble-refs">{codeRef}</span> : null}
        {/* the cross-layer door: the one link between what the project promises
            and what builds it, so it is a button on the card rather than a
            number in a panel. Hidden at zero, which is what `unrealized` is. */}
        {product && realizerCount > 0 && tier !== "min" && !comparing ? (
          <button
            type="button"
            className="built-by nodrag nopan"
            title={`show the ${realizerCount} build ${realizerCount === 1 ? "bubble" : "bubbles"} that make “${node.label}” real`}
            onClick={(event) => {
              event.stopPropagation();
              drillRealizers(node.id);
            }}
          >
            built by {realizerCount}
          </button>
        ) : null}
        {/* the same door read from the infrastructure end: a piece of infra says
            how much of the project runs on it, and opening it shows exactly
            those parts. A database nothing admits to using is quiet, not loud —
            unlike a capability, that is not a claim anyone failed to keep. */}
        {infra && hostCount > 0 && tier !== "min" && !comparing ? (
          <button
            type="button"
            className="built-by runs-parts nodrag nopan"
            title={`show the ${hostCount} ${hostCount === 1 ? "part" : "parts"} that run on “${node.label}”`}
            onClick={(event) => {
              event.stopPropagation();
              drillHosts(node.id);
            }}
          >
            runs {hostCount} {hostCount === 1 ? "part" : "parts"}
          </button>
        ) : null}
        {/* And read from the verification end: a check says how much of the
            project it attests, and opening it shows exactly those parts. */}
        {verifies && verifyCount > 0 && tier !== "min" && !comparing ? (
          <button
            type="button"
            className="built-by verifies-parts nodrag nopan"
            title={`show the ${verifyCount} ${verifyCount === 1 ? "part" : "parts"} “${node.label}” attests`}
            onClick={(event) => {
              event.stopPropagation();
              drillVerified(node.id);
            }}
          >
            verifies {verifyCount} {verifyCount === 1 ? "part" : "parts"}
          </button>
        ) : null}
        {/* The same door read from the build end: a part says how many checks
            cover it, and opening it shows exactly those checks. Zero is hidden
            because a hollow shield already says so. */}
        {build && coverCount > 0 && tier !== "min" && !comparing ? (
          <button
            type="button"
            className="built-by covered-by nodrag nopan"
            title={`show the ${coverCount} ${coverCount === 1 ? "check" : "checks"} that cover “${node.label}”`}
            onClick={(event) => {
              event.stopPropagation();
              drillCovering(node.id);
            }}
          >
            covered by {coverCount}
          </button>
        ) : null}
        {/* The "built by" door read from the build end: a part says how many
            capabilities it serves, and opening it shows exactly those
            capabilities. */}
        {!product && detail && serveCount > 0 && !comparing ? (
          <button
            type="button"
            className="built-by serves nodrag nopan"
            title={`show the ${serveCount} ${serveCount === 1 ? "capability" : "capabilities"} “${node.label}” serves`}
            onClick={(event) => {
              event.stopPropagation();
              drillServed(node.id);
            }}
          >
            serves {serveCount}
          </button>
        ) : null}
      </div>

      {/* Where else this bubble lives. One dot per variation that has it, in
          that variation's colour, hollow where its copy says something else —
          the whole reason the canvas merges them rather than switching between
          them. Nothing is drawn when only one variation is on screen. */}
      {pips.length > 1 ? (
        <div className="bubble-pips" aria-hidden="true">
          {pips.map((pip) => (
            <span
              key={pip.worktree}
              className="bubble-pip"
              style={{ ["--wt" as string]: `var(--wt-${pip.tone})` }}
              data-differs={pip.differs}
              data-primary={pip.primary}
              title={
                pip.primary
                  ? `shown from ${pip.branch}`
                  : pip.differs
                    ? `differs on ${pip.branch}`
                    : `also on ${pip.branch}`
              }
            />
          ))}
        </div>
      ) : null}

      {/* Drill affordance: the only way in, alongside double-click. Single click
          stays selection so steering never changes what you are looking at.
          A real bubble counts what is inside it; the fold IS what is inside it,
          so counting again would only repeat its own label.
          A leaf offers the same door onto its own code: nobody wrote those
          classes down as bubbles, and they are still what is inside it. */}
      {insideCount > 0 ? (
        <button
          type="button"
          className="drill-chip nodrag nopan"
          data-mechanical={mechanical}
          title={
            isMore
              ? `open the ${childCount} folded parts`
              : mechanical
                ? `open ${node.label} — ${symbolCount} ${symbolCount === 1 ? "class or function" : "classes and functions"} in its code`
                : `open ${node.label} — ${childCount} inside`
          }
          onClick={(event) => {
            event.stopPropagation();
            setFocus(node.id);
          }}
        >
          {isMore
            ? "open"
            : tier === "min"
              ? null
              : isRoot
                ? `${childCount} ${childCount === 1 ? "capability" : "capabilities"}`
                : mechanical
                  ? `${symbolCount} in code`
                  : `${childCount} inside`}{" "}
          <span className="drill-caret">›</span>
        </button>
      ) : null}

      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}
