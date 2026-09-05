import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentState, LinkGap } from "../../shared/src/index.ts";
import { selectLayer } from "./layer.ts";
import { NO_WORKTREES, selectAgent, selectRunningSession, useApp } from "./store.ts";
import {
  edgeTldr,
  nodeTldr,
  nodeWhere,
  projectTldr,
  type NeighbourLink,
  type ProjectTldr,
  type NodeTldr,
  type EdgeTldr,
  type WherePlace,
} from "./tldr.ts";

/** stable empty snapshot: nothing to say about where a bubble also lives */
const NO_PLACES: readonly WherePlace[] = [];

const AGENT_LABEL: Record<AgentState, string> = {
  idle: "idle",
  streaming: "working",
  compacting: "compacting",
};

/** where this harness's terminal is, said the way "Go to terminal" behaves */
const TERMINAL_CAP: Record<string, string> = {
  external: "runs in your own terminal",
  none: "no terminal to go to",
};

const KIND_ARROW: Record<string, string> = {
  out: "→",
  in: "←",
};

/**
 * Each cross-layer silence in two halves: a short name and what would close it
 * (user decision 2026-09-04 — connection is the default, so the panel says how
 * to connect rather than only that nothing is connected). Said in the reader's
 * register, so no field names: "ask the agent" is how they close it.
 * `unrealized` is absent: it is loud enough to keep the block of its own.
 */
const GAP_NOTE: Partial<Record<LinkGap, { name: string; say: string }>> = {
  unserved: { name: "no capability", say: "Nothing on the product side says what this part is for. Ask which capability it serves." },
  unhosted: { name: "nowhere to run", say: "Nothing on the infra side runs this part. Ask where it runs." },
  unattested: { name: "nothing checks it", say: "This part is finished and nothing shows it works. Ask for a test or a check that covers it." },
  "hosts-nothing": { name: "runs nothing", say: "No part is said to run on this. Ask which parts it runs." },
  "attests-nothing": { name: "checks nothing", say: "This check is not said to cover any part. Ask which parts it proves." },
};

function NodeChip({ target }: { target: NeighbourLink }) {
  const select = useApp((state) => state.select);
  return (
    <button
      type="button"
      className="node-chip"
      data-phase={target.phase}
      onClick={() => select({ kind: "node", id: target.id })}
      title={`select ${target.id}`}
    >
      <span className="node-chip-dot" />
      {target.label}
    </button>
  );
}

/**
 * A chip that leads to the other layer. Selecting it where it is would highlight
 * a bubble this canvas is not drawing, so it switches the view on the way —
 * following the one link between what a project promises and what builds it.
 */
function CrossChip({ target }: { target: NeighbourLink }) {
  const revealNode = useApp((state) => state.revealNode);
  return (
    <button
      type="button"
      className="node-chip node-chip-cross"
      data-phase={target.phase}
      onClick={() => revealNode(target.id)}
      title={`open ${target.id} in the layer it lives in`}
    >
      <span className="node-chip-dot" />
      {target.label}
      <span className="node-chip-arrow">›</span>
    </button>
  );
}

function Lines({ lines, empty }: { lines: { seq: number; role: string; text: string }[]; empty: string }) {
  if (lines.length === 0) return <p className="tl-empty">{empty}</p>;
  return (
    <div className="tl-lines">
      {lines.map((line) => (
        <div key={line.seq} className={`entry entry-${line.role}`}>
          <span className="entry-role">{line.role}</span>
          <span className="entry-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

function ProjectView({ tldr, agent }: { tldr: ProjectTldr; agent: AgentState }) {
  const setFocus = useApp((state) => state.setFocus);
  // the harness of the variation the panel is speaking for: what drives one
  // variation is that variation's own fact now
  const running = useApp(selectRunningSession);
  const backend = running?.backend;
  const model = running?.session.model ?? null;

  return (
    <>
      {backend === undefined ? null : (
        <section className="tl-block">
          <h2 className="tl-title">harness</h2>
          <p className="tl-harness">
            <strong>{backend.label}</strong>
            {model === null ? null : <> · {model.id}</>}
            <span className="tl-harness-caps">
              {`how Shape hears it: ${backend.capabilities.events}`} · {TERMINAL_CAP[backend.capabilities.terminal]}
            </span>
          </p>
        </section>
      )}
      <section className="tl-block">
        <h2 className="tl-title">now</h2>
        {tldr.working.length === 0 ? (
          <p className="tl-empty">
            {agent === "idle"
              ? "Nothing in flight."
              : "Working, but not inside a bubble it has mapped to code yet."}
          </p>
        ) : (
          <ul className="tl-working">
            {tldr.working.map((bubble) => (
              <li key={bubble.id} className="tl-working-item" data-phase={bubble.phase}>
                <span className="tl-working-where">
                  <NodeChip target={{ id: bubble.id, label: bubble.label, phase: bubble.phase }} />
                  {bubble.insideOf === null ? null : (
                    <span className="tl-inside">
                      inside{" "}
                      <button
                        type="button"
                        className="tl-inside-link"
                        onClick={() => setFocus(bubble.insideOf === null ? null : bubble.insideOf.id)}
                        title="drill into the bubble that contains it"
                      >
                        {bubble.insideOf.label}
                      </button>
                    </span>
                  )}
                </span>
                {bubble.status === null ? (
                  <span className="tl-status tl-status-absent">no status reported</span>
                ) : (
                  <span className="tl-status">{bubble.status}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="tl-block">
        <h2 className="tl-title">shape</h2>
        <div className="tl-tallies">
          {tldr.tallies.map((tally) => (
            <span key={tally.phase} className="tl-tally" data-phase={tally.phase}>
              <i />
              {tally.count} {tally.phase}
            </span>
          ))}
        </div>
        {tldr.driftNodes === 0 ? (
          <p className="tl-note tl-note-ok">Intent and code agree everywhere they have been checked.</p>
        ) : (
          <p className="tl-note tl-note-drift">
            {tldr.driftNotes} drift {tldr.driftNotes === 1 ? "note" : "notes"} across {tldr.driftNodes}{" "}
            {tldr.driftNodes === 1 ? "bubble" : "bubbles"} — those bubbles glow on the canvas.
          </p>
        )}
      </section>

      <section className="tl-block">
        <h2 className="tl-title">latest</h2>
        <Lines lines={tldr.narration} empty="The agent has not narrated anything yet." />
      </section>
    </>
  );
}

function NodeView({ tldr, places }: { tldr: NodeTldr; places: readonly WherePlace[] }) {
  const { node } = tldr;
  // everything the block below has words for: `unrealized` says itself, loudly,
  // in the block above this one
  const unconnected = tldr.gaps.filter((gap) => gap !== "unrealized");
  return (
    <>
      <section className="tl-block">
        <div className="tl-subject" data-phase={node.phase}>
          <span className="tl-subject-dot" />
          <h2 className="tl-subject-label">{node.label}</h2>
          <span className="tl-subject-phase">{node.phase}</span>
          {tldr.working ? <span className="tl-live">live</span> : null}
          {tldr.layer === "product" ? <span className="tl-subject-layer">capability</span> : null}
          {tldr.layer === "infra" ? <span className="tl-subject-layer">infrastructure</span> : null}
          {tldr.layer === "correctness" ? <span className="tl-subject-layer">verification</span> : null}
        </div>
        <p className="tl-promise">{node.summary}</p>
        {node.status === undefined ? null : (
          <p className="tl-now">
            <span className="tl-now-tag">now</span>
            {node.status}
          </p>
        )}
        <div className="tl-meta">
          <span className="mono">{node.id}</span>
          {node.modelRole === undefined ? null : <span className="badge badge-role">{node.modelRole}</span>}
        </div>
      </section>

      {/* Where. The card above is one variation's copy of this bubble — the
          main worktree's when it has one — so this is what the others say
          about it. Drawn only when they disagree: variations that say the same
          thing are already answered by the pips on the bubble. */}
      {places.length === 0 ? null : (
        <section className="tl-block">
          <h2 className="tl-title">where</h2>
          <ul className="tl-where">
            {places.map((place) => (
              <li key={place.worktree} className="tl-where-row" data-absent={!place.present}>
                <span className="tl-where-branch">
                  <span
                    className="variation-swatch"
                    style={{ ["--wt" as string]: `var(--wt-${place.tone})` }}
                  />
                  {place.branch}
                </span>
                {place.present ? (
                  <>
                    <span className="tl-where-phase" data-phase={place.phase ?? undefined}>
                      {place.phase}
                    </span>
                    <span className="tl-where-status">{place.status ?? "no status reported"}</span>
                  </>
                ) : (
                  <span className="tl-where-status">not on this variation</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {tldr.drift.length === 0 ? null : (
        <section className="tl-block">
          <h2 className="tl-title tl-title-drift">drift</h2>
          <ul className="tl-drift">
            {tldr.drift.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      )}

      {/* the one cross-layer reading: a capability says what makes it real, a
          part says what it is for. An unrealized capability says the silence
          out loud — it is the one thing a product layer can know that a build
          layer cannot. */}
      {tldr.unrealized ? (
        <section className="tl-block">
          <h2 className="tl-title tl-title-unrealized">unrealized</h2>
          <p className="tl-unrealized">Nothing on the build side makes this real yet.</p>
        </section>
      ) : null}

      {/* And the rest of the same reading, in both directions: cross-layer
          connection is the default (user decision 2026-09-04), so a bubble
          nothing points at — and one that points at nothing — says which link
          is missing and who would write it. One row per silence, in the order
          `linkGapsOf` returns them, which is the order the card says them in. */}
      {unconnected.length === 0 ? null : (
        <section className="tl-block">
          <h2 className="tl-title tl-title-gap">not connected</h2>
          <ul className="tl-gaps">
            {unconnected.map((gap) => (
              <li key={gap} className="tl-gap">
                <span className="tl-gap-name">{GAP_NOTE[gap]?.name ?? gap}</span>
                <span className="tl-gap-say">{GAP_NOTE[gap]?.say}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tldr.realizers.length === 0 && tldr.serves.length === 0 ? null : (
        <section className="tl-block">
          <h2 className="tl-title">{tldr.layer === "product" ? "built by" : "serves"}</h2>
          <div className="tl-row">
            <span className="tl-row-key">{tldr.layer === "product" ? "build side" : "capabilities"}</span>
            <span className="tl-chips">
              {(tldr.layer === "product" ? tldr.realizers : tldr.serves).map((target) => (
                <CrossChip key={target.id} target={target} />
              ))}
            </span>
          </div>
        </section>
      )}

      {/* Where it runs. On a build bubble these are the pieces of infrastructure
          its own `hosts` links name; on a capability, the same list rolled up
          through its realizers, because a promise runs wherever the parts that
          keep it run. Read from the infrastructure end it is the other way
          round: the parts running on this one. */}
      {tldr.runsOn.length === 0 ? null : (
        <section className="tl-block">
          <h2 className="tl-title">{tldr.layer === "infra" ? "runs" : "runs on"}</h2>
          <div className="tl-row">
            <span className="tl-row-key">{tldr.layer === "infra" ? "these parts" : "infrastructure"}</span>
            <span className="tl-chips">
              {tldr.runsOn.map((target) => (
                <CrossChip key={target.id} target={target} />
              ))}
            </span>
          </div>
        </section>
      )}

      {/* What attests this part, and both halves of the answer, because a
          filled shield the reader cannot account for teaches nothing. The
          authored half is chips: a verification is a bubble, so it can be
          opened. The extracted half is not — nobody wrote it down — so it is
          listed as evidence, quietly, with the files it was read from. */}
      {tldr.verifiers.length === 0 && tldr.covering.length === 0 ? null : (
        <section className="tl-block">
          <h2 className="tl-title">verified by</h2>
          {tldr.verifiers.length === 0 ? null : (
            <div className="tl-row">
              <span className="tl-row-key">on the canvas</span>
              <span className="tl-chips">
                {tldr.verifiers.map((target) => (
                  <CrossChip key={target.id} target={target} />
                ))}
              </span>
            </div>
          )}
          {tldr.covering.length === 0 ? null : (
            <ul className="tl-covering">
              {tldr.covering.map((item) => (
                <li key={item.id} className="tl-covering-row">
                  <span className="tl-covering-head">
                    <span className="tl-covering-kind" data-kind={item.kind}>
                      {item.kind}
                    </span>
                    <span className="tl-covering-label">{item.label}</span>
                  </span>
                  <span className="tl-covering-note">{item.hint}</span>
                  <span className="tl-covering-where">{item.evidence.join(", ")}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Read from the verification end, the same link says what this check
          answers for. */}
      {tldr.verifies.length === 0 ? null : (
        <section className="tl-block">
          <h2 className="tl-title">attests</h2>
          <div className="tl-row">
            <span className="tl-row-key">these parts</span>
            <span className="tl-chips">
              {tldr.verifies.map((target) => (
                <CrossChip key={target.id} target={target} />
              ))}
            </span>
          </div>
        </section>
      )}

      {/* A promise is only as attested as the parts keeping it, so the rollup
          names the ones nothing attests rather than leaving a reader to check
          each realizer by hand. */}
      {tldr.verification === "none" ? null : (
        <section className="tl-block">
          <h2 className="tl-title">verified</h2>
          <p className="tl-verified" data-state={tldr.verification}>
            {tldr.verification === "verified"
              ? "Everything behind this promise has something attesting it."
              : tldr.verification === "partial"
                ? "Only some of what keeps this promise is attested."
                : "Nothing behind this promise is attested yet."}
          </p>
          {tldr.unverifiedParts.length === 0 ? null : (
            <div className="tl-row">
              <span className="tl-row-key">nothing attests</span>
              <span className="tl-chips">
                {tldr.unverifiedParts.map((target) => (
                  <CrossChip key={target.id} target={target} />
                ))}
              </span>
            </div>
          )}
        </section>
      )}

      {/* The mechanical inside of a leaf: what the code holds that nobody wrote
          down as a bubble. The canvas draws the first few as ghosts; the whole
          list lives here, with the line to open the file at. */}
      {tldr.inside.length === 0 ? null : (
        <section className="tl-block">
          <h2 className="tl-title">inside</h2>
          <p className="tl-inside-note">
            Read from the code, not from the canvas — {tldr.inside.length}{" "}
            {tldr.inside.length === 1 ? "class or function" : "classes and functions"} no bubble claims.
          </p>
          <ul className="tl-inside">
            {tldr.inside.map((symbol) => (
              <li key={symbol.id} className="tl-inside-row">
                <span className="tl-inside-head">
                  <span className="tl-inside-kind" data-kind={symbol.kind}>
                    {symbol.kind === "class" ? "class" : "fn"}
                  </span>
                  <span className="tl-inside-name">{symbol.name}</span>
                  {symbol.exported ? <span className="tl-inside-export">exported</span> : null}
                </span>
                <span className="tl-inside-where">
                  {symbol.file}:{symbol.line}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tldr.parent === null && tldr.children.length === 0 ? null : (
        <section className="tl-block">
          <h2 className="tl-title">hierarchy</h2>
          {tldr.parent === null ? null : (
            <div className="tl-row">
              <span className="tl-row-key">part of</span>
              <NodeChip target={tldr.parent} />
            </div>
          )}
          {tldr.children.length === 0 ? null : (
            <div className="tl-row">
              <span className="tl-row-key">splits into</span>
              <span className="tl-chips">
                {tldr.children.map((child) => (
                  <NodeChip key={child.id} target={child} />
                ))}
              </span>
            </div>
          )}
        </section>
      )}

      <section className="tl-block">
        <h2 className="tl-title">relations</h2>
        {tldr.relations.length === 0 ? (
          <p className="tl-empty">No declared relations — nothing says how this part meets another one.</p>
        ) : (
          <ul className="tl-relations">
            {tldr.relations.map((relation) => (
              <li key={relation.edgeId} className="tl-relation">
                <span className={`tl-relation-kind rel-${relation.kind}`}>{relation.kind}</span>
                <span className="tl-relation-dir">{KIND_ARROW[relation.direction]}</span>
                <NodeChip target={relation.other} />
                {relation.label === null ? null : <span className="tl-relation-label">{relation.label}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {node.codeRefs === undefined || node.codeRefs.length === 0 ? null : (
        <section className="tl-block">
          <h2 className="tl-title">code</h2>
          <ul className="tl-refs">
            {node.codeRefs.map((ref) => (
              <li key={ref} className="mono">
                {ref}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="tl-block">
        <h2 className="tl-title">recent activity here</h2>
        <Lines lines={tldr.lines} empty="Nothing in the transcript mentions this bubble yet." />
      </section>
    </>
  );
}

function EdgeView({ tldr }: { tldr: EdgeTldr }) {
  return (
    <>
      <section className="tl-block">
        <div className="tl-subject" data-kind={tldr.edge.kind}>
          <span className={`tl-relation-kind rel-${tldr.edge.kind}`}>{tldr.edge.kind}</span>
          <h2 className="tl-subject-label">{tldr.edge.label ?? "unlabelled relation"}</h2>
        </div>
        <div className="tl-row">
          <span className="tl-row-key">from</span>
          {tldr.source === null ? <span className="mono">{tldr.edge.source}</span> : <NodeChip target={tldr.source} />}
        </div>
        <div className="tl-row">
          <span className="tl-row-key">to</span>
          {tldr.target === null ? <span className="mono">{tldr.edge.target}</span> : <NodeChip target={tldr.target} />}
        </div>
        <div className="tl-meta">
          <span className="mono">{tldr.edge.id}</span>
        </div>
      </section>

      {tldr.drift.length === 0 ? null : (
        <section className="tl-block">
          <h2 className="tl-title tl-title-drift">drift on these endpoints</h2>
          <ul className="tl-drift">
            {tldr.drift.map((item) => (
              <li key={`${item.nodeId}:${item.note}`}>
                <span className="mono">{item.nodeId}</span> — {item.note}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="tl-block">
        <h2 className="tl-title">recent activity here</h2>
        <Lines lines={tldr.lines} empty="Nothing in the transcript mentions either end yet." />
      </section>
    </>
  );
}

/**
 * The rail leads with a reading of the graph rather than the raw stream: what is
 * being worked on now, what shape the project is in, and — when something is
 * selected — everything known about that one thing. The transcript is still
 * here, one click down, because it is the record of what actually happened.
 */
export function SidePanel() {
  const doc = useApp((state) => state.doc);
  const agent = useApp(selectAgent);
  const activity = useApp((state) => state.activeNodes);
  // what the same bubble says in the other variations, for the "where" section
  const graphs = useApp((state) => state.graphs);
  const worktrees = useApp((state) => state.session?.worktrees ?? NO_WORKTREES);
  const filter = useApp((state) => state.filter);
  const worktreeIds = useApp((state) => state.worktreeIds);
  const transcript = useApp((state) => state.transcript);
  const selection = useApp((state) => state.selection);
  const select = useApp((state) => state.select);
  const focus = useApp((state) => state.focus);
  const view = useApp((state) => state.view);

  // the panel annotates working bubbles with the on-screen bubble that stands
  // for them, so the same lift map the canvas uses is what it reads — fold
  // included, which is why it takes the layer's labels with it
  const layer = useMemo(() => selectLayer({ doc, focus, activity, layer: view }), [doc, focus, activity, view]);

  const [collapsed, setCollapsed] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const stream = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = stream.current;
    if (element === null || !showTranscript) return;
    element.scrollTop = element.scrollHeight;
  }, [transcript, showTranscript]);

  const node = selection?.kind === "node" ? nodeTldr(doc, selection.id, activity, transcript) : null;
  const edge = selection?.kind === "edge" ? edgeTldr(doc, selection.id, transcript) : null;
  // what the other variations say about the selected bubble, when they differ
  const places = useMemo(
    () =>
      selection?.kind === "node"
        ? nodeWhere({ graphs, worktrees, filter, worktreeIds, nodeId: selection.id })
        : NO_PLACES,
    [selection, graphs, worktrees, filter, worktreeIds],
  );
  const project = selection === null || (node === null && edge === null);

  return (
    <aside className="rail" data-collapsed={collapsed}>
      <div className="rail-head">
        <button
          type="button"
          className="rail-toggle"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? "expand panel" : "collapse panel"}
          title={collapsed ? "expand panel" : "collapse panel"}
        >
          {collapsed ? "‹" : "›"}
        </button>
        {collapsed ? null : (
          <>
            <span className="rail-title">{project ? "project" : selection?.kind}</span>
            {project ? null : (
              <button type="button" className="rail-back" onClick={() => select(null)} title="back to the project">
                whole project
              </button>
            )}
            <span className={`agent-state agent-${agent}`} title={`agent is ${AGENT_LABEL[agent]}`}>
              <span className="dot" />
              {AGENT_LABEL[agent]}
            </span>
          </>
        )}
      </div>

      {collapsed ? (
        <div className="rail-collapsed-spine">
          <span className={`agent-state agent-${agent}`}>
            <span className="dot" />
          </span>
          <span>tldr</span>
        </div>
      ) : (
        <div className="rail-body">
          {node !== null ? <NodeView tldr={node} places={places} /> : null}
          {edge !== null ? <EdgeView tldr={edge} /> : null}
          {project ? (
            <ProjectView tldr={projectTldr(doc, activity, transcript, layer.liftOf, layer.labelOf)} agent={agent} />
          ) : null}

          <section className="tl-block tl-transcript">
            <button
              type="button"
              className="tl-disclose"
              aria-expanded={showTranscript}
              onClick={() => setShowTranscript((value) => !value)}
            >
              <span className="tl-disclose-caret">{showTranscript ? "▾" : "▸"}</span>
              transcript
              <span className="tl-disclose-count">{transcript.length}</span>
            </button>
            {showTranscript ? (
              <div className="tl-stream" ref={stream}>
                {transcript.length === 0 ? (
                  <p className="tl-empty">Nothing yet.</p>
                ) : (
                  transcript.map((entry) => (
                    <div key={entry.seq} className={`entry entry-${entry.role}`}>
                      <span className="entry-role">{entry.role}</span>
                      <span className="entry-text">{entry.text}</span>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </section>
        </div>
      )}
    </aside>
  );
}
