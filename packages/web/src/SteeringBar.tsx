import { useEffect, useRef, useState } from "react";
import { layerOf, type GraphEdge, type IntentNode, type Referent } from "../../shared/src/index.ts";
import { isMoreId } from "./layer.ts";
import { useApp } from "./store.ts";
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
 * The dictation target. Any dictation tool types plain text into
 * this input, so it takes focus the instant a referent changes: click a bubble,
 * speak, press Enter.
 */
export function SteeringBar() {
  const selection = useApp((state) => state.selection);
  const doc = useApp((state) => state.doc);
  const agent = useApp((state) => state.agent);
  // A past version cannot be steered: the agent works on the project as it is,
  // and nothing on a comparison canvas is a legitimate referent.
  const comparing = useApp((state) => state.delta !== null);
  // no agent, no steering: the server refuses the utterance, so the bar refuses
  // it first and says what to do about it
  const offline = useApp((state) => state.session !== null && !state.session.agentConnected);
  const select = useApp((state) => state.select);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const key = selection === null ? "" : `${selection.kind}:${selection.id}`;
  useEffect(() => {
    input.current?.focus();
  }, [key]);

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

  const commit = (): void => {
    const body = text.trim();
    if (body.length === 0) return;
    // a fold has no document identity, so what goes on the wire is no referent
    // at all rather than an id the bridge has never seen
    const referent = selection !== null && selection.kind === "node" && isMoreId(selection.id) ? null : selection;
    send({ type: "utterance", referent, text: body });
    setText("");
  };

  return (
    <div
      className="steer"
      data-armed={selection !== null && !comparing && !offline}
      data-suspended={comparing}
      data-offline={offline}
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

      <input
        ref={input}
        className="steer-input"
        value={text}
        autoFocus
        spellCheck={false}
        disabled={comparing || offline}
        placeholder={
          comparing
            ? "Looking at an older version — go back to now to steer."
            : offline
              ? ""
              : selection === null
                ? "Say what to build, or click a bubble to address one…"
                : `Steer ${chip.id} — say what should change…`
        }
        aria-label="steering utterance"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
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
        {comparing ? "comparing versions" : offline ? OFFLINE_HINT : ready ? "enter to send" : "dictate or type here"}
      </span>

      {busy && !offline ? (
        <button type="button" className="btn btn-abort" onClick={() => send({ type: "abort" })}>
          Abort
        </button>
      ) : null}

      <button type="button" className="btn btn-send" onClick={commit} disabled={!ready || comparing || offline}>
        Send
      </button>
    </div>
  );
}
