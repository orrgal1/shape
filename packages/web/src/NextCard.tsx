/**
 * The end of a turn, said out loud. A canvas that stops moving says nothing
 * about what happens now, so the agent's own card sits between it and the
 * steering bar: one sentence on where things stand, the ways on as buttons that
 * each send a real sentence, and the decision only the user can make.
 *
 * Nothing here is a choice the user cannot refuse — the input below it always
 * wins, which is what the hint says.
 */
import { useEffect, useRef, useState } from "react";
import { branchOf, NO_RUNNING, NO_WORKTREES, selectNext, selectTarget, useApp } from "./store.ts";
import { send } from "./ws.ts";

export function NextCard() {
  const next = useApp(selectNext);
  const target = useApp(selectTarget);
  const worktrees = useApp((state) => state.session?.worktrees ?? NO_WORKTREES);
  const running = useApp((state) => state.session?.sessions ?? NO_RUNNING);
  // A past version cannot be steered, and neither can a variation with no
  // harness in it: a button that cannot send its sentence is worse than no card.
  const comparing = useApp((state) => state.delta !== null);
  const sleeping = target !== null && !running.some((entry) => entry.worktree === target);
  /**
   * A fresh card slides in; the same card re-rendered does not. The animation is
   * keyed on what the card says, because that is what "a new card" means to the
   * person reading it.
   */
  const [beat, setBeat] = useState(0);
  const said = useRef("");
  const key = next === null ? "" : `${next.summary}|${next.question ?? ""}|${next.choices.map((c) => c.label).join("|")}`;
  useEffect(() => {
    if (key === said.current) return;
    said.current = key;
    if (key !== "") setBeat((value) => value + 1);
  }, [key]);

  if (next === null || target === null || comparing || sleeping) return null;

  // with several variations merged on one canvas, the card has to say whose
  // turn just ended — the buttons steer that one
  const branch = worktrees.length < 2 ? null : branchOf(worktrees, target);

  return (
    <div className="next-card" key={beat} role="group" aria-label="what happens next">
      <p className="next-summary">
        {branch === null ? null : <span className="next-branch">{branch}</span>}
        {next.summary}
      </p>
      {next.question === null ? null : <p className="next-question">{next.question}</p>}
      {next.choices.length === 0 ? (
        <p className="next-done">Nothing waiting on you — say what to do next whenever you like.</p>
      ) : (
        <div className="next-choices">
          {next.choices.map((choice, index) => (
            <button
              key={choice.label}
              type="button"
              className="next-choice"
              data-lead={index === 0}
              title={choice.say}
              onClick={() => send({ type: "utterance", worktree: target, referent: null, text: choice.say })}
            >
              {choice.label}
            </button>
          ))}
          <span className="next-hint">or say it your way</span>
        </div>
      )}
    </div>
  );
}
