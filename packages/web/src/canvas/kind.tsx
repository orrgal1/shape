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
import type { Shield } from "../layer.ts";

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
    case "host":
      // a box with a plinth: the machine the thing runs on
      return (
        <>
          <rect x="2.5" y="3" width="11" height="7" rx="1.5" />
          <path d="M5 13h6M8 10v3" />
          <circle cx="5" cy="6.5" r=".8" className="sigil-fill" />
        </>
      );
    case "database":
      // the store glyph with its bands filled: a real database, not our own
      return (
        <>
          <ellipse cx="8" cy="4" rx="5" ry="2" />
          <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
          <path d="M3 7.4c0 1.1 2.2 2 5 2s5-.9 5-2M3 10.8c0 1.1 2.2 2 5 2s5-.9 5-2" />
        </>
      );
    case "cache":
      // a small fast box with a bolt through it
      return (
        <>
          <rect x="2.5" y="3.5" width="11" height="9" rx="2" />
          <path className="sigil-fill" d="M8.8 5.2 6 8.9h1.9L7.2 12l2.9-3.9H8.2Z" />
        </>
      );
    case "cdn":
      // a globe: the same bytes served from wherever the reader is
      return (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.5 2.4 5.5S9.6 12 8 13.5C6.4 12 5.6 10 5.6 8S6.4 4.1 8 2.5Z" />
        </>
      );
    case "ci":
      // a tick inside a loop: the pipeline that builds and checks it
      return (
        <>
          <path d="M13 6.2A5.4 5.4 0 1 0 13.4 9.6" />
          <path d="M13.6 3v3.4h-3.2" />
          <path d="m5.9 8.3 1.7 1.7 3-3.4" />
        </>
      );
    case "test":
      // a flask: the thing the project is run inside on purpose
      return (
        <>
          <path d="M6 2.2v3.4L3.1 11a1.7 1.7 0 0 0 1.5 2.6h6.8A1.7 1.7 0 0 0 12.9 11L10 5.6V2.2" />
          <path d="M5.2 2.2h5.6" />
          <path className="sigil-fill" d="M4.4 9.6h7.2l1.3 2.3a1.4 1.4 0 0 1-1.2 2.1H4.3a1.4 1.4 0 0 1-1.2-2.1Z" />
        </>
      );
    case "smoke":
      // a route from one end to the other: a script that walks the whole path
      return (
        <>
          <path d="M4.6 11.4c2.6 0 1.4-6.8 3.6-6.8s1 6.8 3.4 6.8" />
          <circle cx="3.2" cy="11.4" r="1.5" className="sigil-fill" />
          <circle cx="12.8" cy="11.4" r="1.5" />
        </>
      );
    case "check":
      // a page with a tick: something read off the source without running it
      return (
        <>
          <path d="M3.5 2.5h6L12.5 5.5v8h-9Z" />
          <path d="M9.5 2.5v3h3" />
          <path d="m5.6 9.4 1.5 1.5 2.9-3" />
        </>
      );
    case "review":
      // an eye: the one kind of verification a person performs
      return (
        <>
          <path d="M1.6 8S4 4 8 4s6.4 4 6.4 4-2.4 4-6.4 4-6.4-4-6.4-4Z" />
          <circle cx="8" cy="8" r="1.7" className="sigil-fill" />
        </>
      );
    case "monitor":
      // a heartbeat: verification that keeps running after the release
      return (
        <>
          <rect x="1.8" y="3.5" width="12.4" height="9" rx="1.8" />
          <path d="M3.6 8h2l1.3-2.4L9.2 10.4l1.1-2.4h2.1" />
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
 * The product layer's one symbol. A capability is not a kind of component —
 * every bubble in that layer is the same kind of thing, something the project
 * promises a person — so the whole layer shares a single sigil: a flag planted,
 * which is what a capability is.
 */
export function CapabilitySigil(): ReactElement {
  return (
    <span className="kind-sigil" data-kind="capability" title="capability">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 14V2.6" />
        <path className="sigil-fill" d="M4 3h7.6l-1.8 2.6L11.6 8H4Z" />
      </svg>
    </span>
  );
}

/**
 * The mechanical inside of a leaf: a class or a function, read out of the code
 * rather than written down by anyone. They are drawn as ghosts, so the sigil's
 * job is only to say which of the two a name is — `{}` for a class, `()` for a
 * function, the way the code itself spells the difference.
 */
export function SymbolSigil({ kind }: { kind: "class" | "function" }): ReactElement {
  return (
    <span className="kind-sigil" data-kind={kind} title={kind}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {kind === "class" ? (
          <path d="M6.4 2.6c-1.6 0-1.2 4.2-2.9 5.4 1.7 1.2 1.3 5.4 2.9 5.4M9.6 2.6c1.6 0 1.2 4.2 2.9 5.4-1.7 1.2-1.3 5.4-2.9 5.4" />
        ) : (
          <path d="M6.6 2.6C5.2 4 4.4 5.9 4.4 8s.8 4 2.2 5.4M9.4 2.6c1.4 1.4 2.2 3.3 2.2 5.4s-.8 4-2.2 5.4" />
        )}
      </svg>
    </span>
  );
}

/**
 * The shield: whether anything attests that a bubble works. Deliberately not a
 * kind sigil — it says nothing about what a bubble IS, only whether it is
 * backed — so it is its own mark, and it sits in the meta row beside the phase
 * label rather than in the head, where the phase dot and the drift flag already
 * compete for a reader's eye.
 *
 * Filled means something attests it, hollow means nothing does, and a half-fill
 * is the reading only a capability can have: some of what keeps this promise is
 * attested and some is not.
 */
const SHIELD_TIP: Record<"part" | "capability", Record<Shield, string>> = {
  part: {
    verified: "something attests this works",
    partial: "some of what is inside this is attested",
    unverified: "nothing attests this yet",
  },
  capability: {
    verified: "everything behind this is attested",
    partial: "only some of what is behind this is attested",
    unverified: "nothing behind this is attested yet",
  },
};

/** the shield outline, and the two ways of filling it */
const SHIELD_OUTLINE = "M8 1.9 13.2 3.9v4.2c0 3.2-2 5.6-5.2 6.7-3.2-1.1-5.2-3.5-5.2-6.7V3.9Z";
const SHIELD_HALF = "M8 1.9 2.8 3.9v4.2c0 3.2 2 5.6 5.2 6.7Z";

export function VerifyShield({ state, of }: { state: Shield; of: "part" | "capability" }): ReactElement {
  const tip = SHIELD_TIP[of][state];
  return (
    <span className="verify-shield" data-state={state} title={tip} aria-label={tip} role="img">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d={SHIELD_OUTLINE} />
        {state === "verified" ? <path className="sigil-fill" d={SHIELD_OUTLINE} /> : null}
        {state === "partial" ? <path className="sigil-fill" d={SHIELD_HALF} /> : null}
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
