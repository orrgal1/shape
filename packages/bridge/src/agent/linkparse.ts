/**
 * Boundary validator for the loopback link (`ws://127.0.0.1:<port>/link`).
 *
 * The agent half owns it because it is the end that terminates the link: an
 * MCP server, a harness hook or an adapter sidecar sends these frames, and the
 * agent runtime is what validates and routes them (`agent/external.ts`). The
 * event validator itself lives in `../linkframes.ts` — the same events travel
 * on to the server, and one wire is one validator.
 */

import type { LinkClientMsg } from "../../../shared/src/link.ts";
import { parseAgentEvent } from "../linkframes.ts";

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
