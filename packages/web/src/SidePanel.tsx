import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentState } from "../../shared/src/index.ts";
import { selectLayer } from "./layer.ts";
import { useApp } from "./store.ts";
import {
  edgeTldr,
  nodeTldr,
  projectTldr,
  type NeighbourLink,
  type ProjectTldr,
  type NodeTldr,
  type EdgeTldr,
} from "./tldr.ts";

const AGENT_LABEL: Record<AgentState, string> = {
  idle: "idle",
  streaming: "working",
  compacting: "compacting",
};

const KIND_ARROW: Record<string, string> = {
  out: "→",
  in: "←",
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

  return (
    <>
      <section className="tl-block">
        <h2 className="tl-title">now</h2>
        {tldr.working.length === 0 ? (
          <p className="tl-empty">
            {agent === "idle"
              ? "Nothing in flight. Click a bubble and speak to set the next move."
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

function NodeView({ tldr }: { tldr: NodeTldr }) {
  const { node } = tldr;
  return (
    <>
      <section className="tl-block">
        <div className="tl-subject" data-phase={node.phase}>
          <span className="tl-subject-dot" />
          <h2 className="tl-subject-label">{node.label}</h2>
          <span className="tl-subject-phase">{node.phase}</span>
          {tldr.working ? <span className="tl-live">live</span> : null}
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
          <p className="tl-empty">No declared relations. Draw one by selecting an edge and speaking.</p>
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
  const agent = useApp((state) => state.agent);
  const activity = useApp((state) => state.activity);
  const transcript = useApp((state) => state.transcript);
  const selection = useApp((state) => state.selection);
  const select = useApp((state) => state.select);
  const focus = useApp((state) => state.focus);

  // the panel annotates working bubbles with the on-screen bubble that stands
  // for them, so the same lift map the canvas uses is what it reads
  const liftOf = useMemo(() => selectLayer({ doc, focus, activity }).liftOf, [doc, focus, activity]);

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
          {node !== null ? <NodeView tldr={node} /> : null}
          {edge !== null ? <EdgeView tldr={edge} /> : null}
          {project ? (
            <ProjectView tldr={projectTldr(doc, activity, transcript, liftOf)} agent={agent} />
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
