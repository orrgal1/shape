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
import { isModel, parseAgentEvent } from "../linkframes.ts";

/** Boundary validator for link input; anything else on the socket is not ours. */
export function parseLinkMsg(raw: string): LinkClientMsg | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !("type" in parsed)) return null;
  // the caller's cwd is what routes the frame to a harness: a frame without one
  // cannot be attributed to a worktree, so it is not a frame we accept
  if (!("cwd" in parsed) || typeof parsed.cwd !== "string" || parsed.cwd.length === 0) return null;
  const cwd = parsed.cwd;
  if (parsed.type === "hello") {
    // the harness kind is a free string on purpose: a launcher can host kinds
    // Shape has no adapter for, and the runtime decides what to do about that
    if (!("harness" in parsed) || typeof parsed.harness !== "string" || parsed.harness.length === 0) return null;
    const sessionId = "sessionId" in parsed ? parsed.sessionId : null;
    if (sessionId !== null && typeof sessionId !== "string") return null;
    const sessionFile = "sessionFile" in parsed ? parsed.sessionFile : null;
    if (sessionFile !== null && typeof sessionFile !== "string") return null;
    const model = ("model" in parsed ? parsed.model : null) ?? null;
    if (model !== null && !isModel(model)) return null;
    const caps = "capabilities" in parsed ? parsed.capabilities : null;
    if (caps === null || typeof caps !== "object") return null;
    // a non-null object, checked immediately above; both flags are required —
    // a session that will not say what it can do is not one we can drive
    const flags = caps as Record<string, unknown>;
    if (typeof flags.steer !== "boolean" || typeof flags.tool !== "boolean") return null;
    return {
      type: "hello",
      cwd,
      harness: parsed.harness,
      sessionId: sessionId ?? null,
      sessionFile: sessionFile ?? null,
      model,
      capabilities: { steer: flags.steer, tool: flags.tool },
    };
  }
  if (parsed.type === "canvas_call") {
    if (!("id" in parsed) || typeof parsed.id !== "string" || parsed.id.length === 0) return null;
    return { type: "canvas_call", cwd, id: parsed.id, args: "args" in parsed ? parsed.args : undefined };
  }
  if (parsed.type === "agent_event") {
    if (!("event" in parsed)) return null;
    const event = parseAgentEvent(parsed.event);
    if (event === null) return null;
    return { type: "agent_event", cwd, event };
  }
  if (parsed.type === "delivered") {
    // the receipt answers one `deliver`: without its id it says nothing
    if (!("id" in parsed) || typeof parsed.id !== "string" || parsed.id.length === 0) return null;
    if (!("mode" in parsed) || (parsed.mode !== "prompt" && parsed.mode !== "steer")) return null;
    if (!("queued" in parsed) || typeof parsed.queued !== "boolean") return null;
    return { type: "delivered", cwd, id: parsed.id, mode: parsed.mode, queued: parsed.queued };
  }
  if (parsed.type === "bye") {
    // the reason is what the user reads when the session disappears
    if (!("reason" in parsed) || typeof parsed.reason !== "string") return null;
    return { type: "bye", cwd, reason: parsed.reason };
  }
  return null;
}
