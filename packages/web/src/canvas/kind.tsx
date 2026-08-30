/**
 * Component-type symbols. The phase dot says how far along a bubble is; this
 * says what KIND of thing it is — a screen, a service, a store, a queue — in a
 * single stroke glyph that reads at a glance and costs no words.
 *
 * A node's declared `kind` always wins. The heuristics below are a render-only
 * fallback for graphs authored before the field existed: they never write to the
 * document, and a bubble that matches nothing keeps the plain head it has today.
 *
 * Glyph path data adapted from archify (https://github.com/tt-a1i/archify, MIT),
 * renderers/shared/utils.mjs — its semantic sigils, redrawn as JSX. The `api`
 * request/response glyph is ours; archify has no equivalent shape.
 */
import type { ReactElement } from "react";
import { NODE_KINDS, type IntentNode, type NodeKind } from "../../../shared/src/index.ts";

/** 16x16, stroked in currentColor; `sigil-fill` marks the parts drawn solid */
function glyph(kind: NodeKind): ReactElement {
  switch (kind) {
    case "ui":
      return (
        <>
          <rect x="2" y="3" width="12" height="10" rx="2" />
          <path d="M2 6.5h12" />
          <circle cx="4.1" cy="4.8" r=".7" className="sigil-fill" />
          <circle cx="6.3" cy="4.8" r=".7" className="sigil-fill" />
        </>
      );
    case "service":
      return <path d="M6 3 3 8l3 5M10 3l3 5-3 5" />;
    case "api":
      return (
        <>
          <path d="M2.5 5.5h10.5M10.5 3 13 5.5l-2.5 2.5" />
          <path d="M13.5 10.5H3M5.5 8 3 10.5l2.5 2.5" />
        </>
      );
    case "store":
      return (
        <>
          <ellipse cx="8" cy="4" rx="5" ry="2" />
          <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
        </>
      );
    case "queue":
      return (
        <>
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
          <circle cx="5" cy="4.5" r="1" className="sigil-fill" />
          <circle cx="10.5" cy="8" r="1" className="sigil-fill" />
          <circle cx="7" cy="11.5" r="1" className="sigil-fill" />
        </>
      );
    case "external":
      return (
        <>
          <rect x="2.5" y="5" width="8.5" height="8" rx="1.5" />
          <path d="M8 2.5h5.5V8M13.5 2.5 7.5 8.5" />
        </>
      );
    case "security":
      return (
        <>
          <path d="M8 2.2 13 4v3.5c0 3.1-1.8 5.4-5 6.5-3.2-1.1-5-3.4-5-6.5V4Z" />
          <path d="m5.8 8 1.5 1.5 3-3" />
        </>
      );
  }
}

export function KindSigil({ kind }: { kind: NodeKind }): ReactElement {
  return (
    <span className="kind-sigil" data-kind={kind} title={kind}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {glyph(kind)}
      </svg>
    </span>
  );
}

/**
 * Guesses in priority order, most specific reading first: a "cache API" is an
 * api, and "auth service" is security before it is a service. Word boundaries
 * only, so "dbus" is not a database and "capi" is not an api.
 */
const HEURISTICS: readonly (readonly [NodeKind, RegExp])[] = [
  ["store", /\b(database|db|storage|cache)\b/],
  ["queue", /\b(queue|message bus|broker|pubsub|pub-sub)\b/],
  ["api", /\b(api|endpoint|rest|graphql|rpc)\b/],
  ["security", /\b(auth|login|security|permissions?|access control)\b/],
  ["external", /\b(external|third[- ]party)\b/],
  ["ui", /\b(ui|frontend|screen|interface|canvas|browser)\b/],
  ["service", /\b(service|server|backend|daemon|worker|engine)\b/],
];

/** the declared kind, else a guess from the node's own words, else no symbol */
export function resolveKind(node: IntentNode): NodeKind | null {
  if (node.kind !== undefined && NODE_KINDS.includes(node.kind)) return node.kind;

  const text = `${node.label} ${node.summary} ${node.codeRefs?.join(" ") ?? ""}`.toLowerCase();
  for (const [kind, pattern] of HEURISTICS) {
    if (pattern.test(text)) return kind;
  }
  return null;
}
