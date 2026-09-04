import { useEffect, useRef, useState } from "react";
import { layerOf, type GraphEdge, type IntentNode, type Referent } from "../../shared/src/index.ts";
import { useDismissable } from "./dismiss.ts";
import { isMoreId } from "./layer.ts";
import { branchOf, NO_RUNNING, NO_WORKTREES, selectAgent, selectAutonomous, selectTarget, useApp } from "./store.ts";
import { send } from "./ws.ts";

interface ChipInfo {
  /** null for the implicit whole-project scope */
  kind: "node" | "edge" | null;
  id: string;
  phase: string | null;
  hint: string;
}

function describe(
  referent: Referent | null,
  node: IntentNode | undefined,
  edge: GraphEdge | undefined,
): ChipInfo {
  if (referent === null) {
    return { kind: null, id: "whole project", phase: null, hint: "no referent — the agent decides where this lands" };
  }
  // The fold is a rendering of the parts a layer had no room for, not a part.
  // There is nothing in the document to address, so the utterance lands on the
  // project and the chip says where to go to be specific instead.
  if (referent.kind === "node" && isMoreId(referent.id)) {
    return {
      kind: null,
      id: "whole project",
      phase: null,
      hint: "pick one of the parts inside to steer it",
    };
  }
  if (referent.kind === "node") {
    // A capability is as steerable as a part — it is a bubble in the document
    // like any other. The word is there so an utterance about "this" is aimed
    // knowingly at what the project promises rather than at what builds it.
    const layer = node === undefined || layerOf(node) === "build" ? "" : "capability · ";
    return {
      kind: "node",
      id: referent.id,
      phase: node?.phase ?? null,
      hint: node === undefined ? "unknown node" : `${layer}${node.phase} — ${node.summary}`,
    };
  }
  return {
    kind: "edge",
    id: referent.id,
    phase: null,
    hint: edge === undefined ? "unknown relation" : `${edge.kind}: ${edge.source} → ${edge.target}`,
  };
}

/**
 * The canvas is readable with no agent attached, but nothing on it can be
 * steered: this is what the bar says instead of failing a send.
 */
const OFFLINE_HINT = "No agent attached — start `shape agent` in this project";

/**
 * Which variation the sentence goes to.
 *
 * With several variations merged on one canvas, "the current one" is a property
 * of the click rather than of the connection, so the bar says it out loud and
 * lets it be changed. Every variation the canvas is showing is offered, running
 * or not: the server opens a session for an utterance that arrives at a quiet
 * one, so hiding those would hide the only way to wake them. The menu marks
 * which ones already have a harness with the same dot the variations list uses.
 */
function TargetChip() {
  const worktrees = useApp((state) => state.session?.worktrees ?? NO_WORKTREES);
  const running = useApp((state) => state.session?.sessions ?? NO_RUNNING);
  const filter = useApp((state) => state.filter);
  const target = useApp(selectTarget);
  const setTarget = useApp((state) => state.setTarget);
  const [open, setOpen] = useState(false);
  const menuRef = useDismissable(open, setOpen);

  // one variation in the whole project is just "the project": nothing to name
  if (target === null || worktrees.length < 2) return null;

  const choices = worktrees.map((entry) => entry.id).filter((id) => filter === null || filter.has(id));
  const live = running.some((entry) => entry.worktree === target);
  const label = branchOf(worktrees, target);

  return (
    <span className="steer-target" ref={menuRef} data-live={live}>
      <button
        type="button"
        className="steer-target-chip"
        aria-expanded={open}
        disabled={choices.length < 2}
        title={
          live
            ? `this goes to ${label}${choices.length > 1 ? " — click to send it somewhere else" : ""}`
            : `${label} has no session yet — saying something starts one there`
        }
        onClick={() => setOpen((value) => !value)}
      >
        <span className="steer-target-key">to</span>
        <span className="steer-target-name">{label}</span>
        {choices.length < 2 ? null : <span className="project-caret">▾</span>}
      </button>
      {open ? (
        <div className="project-menu steer-target-menu">
          <p className="project-menu-title">steer which variation</p>
          <ul className="project-recents">
            {choices.map((id) => {
              const here = running.some((entry) => entry.worktree === id);
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="project-recent"
                    data-current={id === target}
                    title={
                      here
                        ? `a session is running on ${branchOf(worktrees, id)}`
                        : `${branchOf(worktrees, id)} has no session yet — saying something starts one there`
                    }
                    onClick={() => {
                      setTarget(id);
                      setOpen(false);
                    }}
                  >
                    <span className="project-recent-name">{branchOf(worktrees, id)}</span>
                    <span className="variation-live" data-on={here}>
                      <span className="dot" />
                    </span>
                    {id === target ? <span className="project-recent-tag">current</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </span>
  );
}

/**
 * Hand the wheel over, or take it back.
 *
 * With this on, the bridge answers the end of every turn for the user — it
 * takes the option the agent would have recommended and keeps going until the
 * agent says the work is finished. That is a big thing to be true silently, so
 * the chip pulses while it is on and says in plain words what it is doing; one
 * click pauses it. It is per variation, like everything else the bar does: one
 * branch can run on its own while another waits for you.
 */
function AutonomyChip() {
  const target = useApp(selectTarget);
  const on = useApp(selectAutonomous);
  const worktrees = useApp((state) => state.session?.worktrees ?? NO_WORKTREES);
  const running = useApp((state) => state.session?.sessions ?? NO_RUNNING);
  const offline = useApp((state) => state.session !== null && !state.session.agentConnected);
  if (target === null) return null;

  const sleeping = !running.some((entry) => entry.worktree === target);
  const blocked = sleeping || offline;
  const label = worktrees.length < 2 ? "" : ` on ${branchOf(worktrees, target)}`;

  return (
    <button
      type="button"
      className="steer-auto"
      data-on={on}
      disabled={blocked}
      aria-pressed={on}
      title={
        blocked
          ? offline
            ? OFFLINE_HINT
            : `nothing is running on ${branchOf(worktrees, target)} yet — it starts when you say something below`
          : on
            ? `it is deciding for itself${label} — click to take the wheel back`
            : `let it decide for itself${label} and keep going without you`
      }
      onClick={() => send({ type: "set_autonomous", worktree: target, on: !on })}
    >
      {on ? (
        <>
          <span className="steer-auto-beat" aria-hidden="true" />
          autonomous — it decides and keeps going
        </>
      ) : (
        "let it run on its own"
      )}
    </button>
  );
}

/**
 * The dictation target. Any dictation tool types plain text into
 * this input, so it takes focus the instant a referent changes: click a bubble,
 * speak, press Enter.
 */
export function SteeringBar() {
  const selection = useApp((state) => state.selection);
  const doc = useApp((state) => state.doc);
  const agent = useApp(selectAgent);
  // Which variation this sentence lands in, and whether a harness is already
  // there to hear it. A quiet one is not a refusal any more: the server opens
  // the session for the utterance and delivers it, so the only thing the bar
  // owes the user is saying that is what pressing enter will do.
  const target = useApp(selectTarget);
  const worktrees = useApp((state) => state.session?.worktrees ?? NO_WORKTREES);
  const running = useApp((state) => state.session?.sessions ?? NO_RUNNING);
  const sleeping = target !== null && !running.some((entry) => entry.worktree === target);
  // A past version cannot be steered: the agent works on the project as it is,
  // and nothing on a comparison canvas is a legitimate referent.
  const comparing = useApp((state) => state.delta !== null);
  // no agent, no steering: the server refuses the utterance, so the bar refuses
  // it first and says what to do about it
  const offline = useApp((state) => state.session !== null && !state.session.agentConnected);
  const select = useApp((state) => state.select);
  // the empty-canvas choice the first utterance carries
  const productFirst = useApp((state) => state.productFirst);
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  const key = selection === null ? "" : `${selection.kind}:${selection.id}`;
  useEffect(() => {
    input.current?.focus();
  }, [key]);

  // A dictated sentence is often longer than the bar: the box grows with the
  // text up to the CSS max-height (five lines), then scrolls. Measuring from
  // zero is what lets it shrink back when text is deleted or sent.
  useEffect(() => {
    const box = input.current;
    if (box === null) return;
    box.style.height = "0px";
    box.style.height = `${box.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  const node = selection?.kind === "node" ? doc.nodes.find((n) => n.id === selection.id) : undefined;
  const edge = selection?.kind === "edge" ? doc.edges.find((e) => e.id === selection.id) : undefined;
  const chip = describe(selection, node, edge);
  const busy = agent === "streaming" || agent === "compacting";
  const ready = text.trim().length > 0;
  // the product picture is up and nothing is built yet: what the bar is for
  // right now is correcting it, or letting the build start
  const picture = doc.nodes.length > 0 && doc.nodes.every((n) => layerOf(n) === "product");

  // the two refusals that still hold: there is no agent to carry the sentence,
  // or there is no variation on the canvas for it to land in
  const nowhere = target === null;
  const blocked = comparing || offline || nowhere;
  // what enter does when nothing is running there yet
  const opens = nowhere ? "" : `starts a session on ${branchOf(worktrees, target)} and says this to it`;

  const commit = (): void => {
    const body = text.trim();
    if (body.length === 0 || target === null) return;
    // a fold has no document identity, so what goes on the wire is no referent
    // at all rather than an id the bridge has never seen
    const referent = selection !== null && selection.kind === "node" && isMoreId(selection.id) ? null : selection;
    // the flag only means anything on an empty canvas, so it only rides along
    // there — every later utterance is just an utterance
    send(
      doc.nodes.length === 0
        ? { type: "utterance", worktree: target, referent, text: body, productFirst }
        : { type: "utterance", worktree: target, referent, text: body },
    );
    setText("");
  };

  return (
    <div
      className="steer"
      data-armed={selection !== null && !blocked}
      data-suspended={comparing}
      data-offline={offline || nowhere}
    >
      <span className="referent" data-kind={chip.kind ?? "none"} data-phase={chip.phase ?? ""} title={chip.hint}>
        {chip.kind === null ? null : <span className="referent-kind">{chip.kind}</span>}
        <span className="referent-id mono">{chip.id}</span>
        {selection === null ? null : (
          <button type="button" className="referent-clear" onClick={() => select(null)} aria-label="clear selection">
            ×
          </button>
        )}
      </span>

      <TargetChip />

      <AutonomyChip />

      <textarea
        ref={input}
        className="steer-input"
        value={text}
        rows={1}
        autoFocus
        spellCheck={false}
        disabled={blocked}
        placeholder={
          comparing
            ? "Looking at an older version — go back to now to steer."
            : offline || nowhere
              ? ""
              : selection !== null
                ? `Steer ${chip.id} — say what should change…`
                : sleeping
                  ? `Say what to do — this starts a session on ${branchOf(worktrees, target)}…`
                  : picture
                    ? 'Correct the picture, or say "build it"'
                    : "Say what to build, or click a bubble to address one…"
        }
        aria-label="steering utterance"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter is the one way to put a line break in
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            commit();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            select(null);
          }
        }}
      />

      <span className="steer-hint">
        {comparing
          ? "comparing versions"
          : offline
            ? OFFLINE_HINT
            : nowhere
              ? "no variation to steer"
              : sleeping
                ? ready
                  ? `enter ${opens}`
                  : opens
                : ready
                  ? "enter to send"
                  : "dictate or type here"}
      </span>

      {busy && !blocked && target !== null ? (
        <button type="button" className="btn btn-abort" onClick={() => send({ type: "abort", worktree: target })}>
          Abort
        </button>
      ) : null}

      <button
        type="button"
        className="btn btn-send"
        onClick={commit}
        disabled={!ready || blocked}
      >
        Send
      </button>
    </div>
  );
}
