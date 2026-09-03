/**
 * Boundary validators for the loopback link (`ws://127.0.0.1:<port>/link`).
 *
 * The agent half owns them because it is the end that terminates the link: an
 * MCP server, a harness hook or an adapter sidecar sends these frames, and the
 * agent runtime is what validates and routes them (`agent/external.ts`).
 */

import type { AgentEvent, LinkClientMsg } from "../../../shared/src/link.ts";

/** the six event kinds the link may report, validated field by field */
export function parseAgentEvent(value: unknown): AgentEvent | null {
  if (value === null || typeof value !== "object" || !("kind" in value)) return null;
  // an object from JSON.parse, checked immediately above; every field below is
  // read as `unknown` and validated before it reaches the union
  const ev = value as Record<string, unknown>;
  switch (ev.kind) {
    case "state":
      if (ev.state !== "idle" && ev.state !== "streaming" && ev.state !== "compacting") return null;
      return { kind: "state", state: ev.state };
    case "text":
      if (typeof ev.text !== "string") return null;
      return { kind: "text", text: ev.text };
    case "tool_start": {
      if (typeof ev.name !== "string" || typeof ev.summary !== "string") return null;
      if (!Array.isArray(ev.paths) || ev.paths.some((p) => typeof p !== "string")) return null;
      // every element was just checked to be a string
      const paths = ev.paths as string[];
      return { kind: "tool_start", name: ev.name, paths, summary: ev.summary };
    }
    case "tool_end":
      if (typeof ev.name !== "string" || typeof ev.isError !== "boolean") return null;
      return { kind: "tool_end", name: ev.name, isError: ev.isError };
    case "turn_end":
      return { kind: "turn_end" };
    case "session": {
      if (ev.sessionId !== null && typeof ev.sessionId !== "string") return null;
      const raw = ev.model;
      let model: { provider: string; id: string } | null = null;
      if (raw !== null && raw !== undefined) {
        if (typeof raw !== "object") return null;
        // non-null object, checked immediately above
        const m = raw as Record<string, unknown>;
        if (typeof m.provider !== "string" || typeof m.id !== "string") return null;
        model = { provider: m.provider, id: m.id };
      }
      return { kind: "session", sessionId: ev.sessionId ?? null, model };
    }
    default:
      return null;
  }
}

/** Boundary validator for link input; anything else on the socket is not ours. */
export function parseLinkMsg(raw: string): LinkClientMsg | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !("type" in parsed)) return null;
  if (parsed.type === "canvas_call") {
    if (!("id" in parsed) || typeof parsed.id !== "string" || parsed.id.length === 0) return null;
    return { type: "canvas_call", id: parsed.id, args: "args" in parsed ? parsed.args : undefined };
  }
  if (parsed.type === "agent_event") {
    if (!("event" in parsed)) return null;
    const event = parseAgentEvent(parsed.event);
    if (event === null) return null;
    return { type: "agent_event", event };
  }
  return null;
}
