import type { WebSocket } from "ws";
import {
  EDGE_KINDS,
  MODEL_ROLES,
  NODE_KINDS,
  PHASES,
  type CanvasOp,
  type ControlErrorResponse,
  type ControlRequest,
  type ControlResponse,
  type GraphEdge,
  type IntentNode,
  type RealityLayer,
  type RepositoryDescriptor,
} from "../../../shared/src/index.ts";

export interface ControlEndpointOptions {
  onRequest: (tenant: string, request: ControlRequest) => Promise<ControlResponse>;
}

const MAX_CONTROL_FRAME_BYTES = 4 * 1024 * 1024;

interface ParseFailure {
  requestId: string;
  message: string;
}

export type ParsedControlRequest = { request: ControlRequest; error?: never } | { request?: never; error: ParseFailure };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => key in value)
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function repository(value: unknown): RepositoryDescriptor | null {
  const repo = record(value);
  if (repo === null || !exactKeys(repo, ["id", "label", "path"])) return null;
  if (!nonempty(repo.id) || !nonempty(repo.label) || !nonempty(repo.path)) return null;
  return { id: repo.id, label: repo.label, path: repo.path };
}

function branch(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("refs/heads/") && value.length > "refs/heads/".length;
}

function commitId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function node(value: unknown): value is IntentNode {
  const n = record(value);
  if (n === null) return false;
  if (
    !exactKeys(n, ["id", "parentId", "label", "summary", "phase"], [
      "status",
      "modelRole",
      "kind",
      "codeRefs",
      "layer",
      "realizes",
      "hosts",
      "verifies",
    ])
  ) {
    return false;
  }
  if (!nonempty(n.id) || !nullableString(n.parentId) || typeof n.label !== "string" || typeof n.summary !== "string") return false;
  if (!PHASES.includes(n.phase as (typeof PHASES)[number])) return false;
  if (n.status !== undefined && typeof n.status !== "string") return false;
  if (n.modelRole !== undefined && !MODEL_ROLES.includes(n.modelRole as (typeof MODEL_ROLES)[number])) return false;
  if (n.kind !== undefined && !NODE_KINDS.includes(n.kind as (typeof NODE_KINDS)[number])) return false;
  if (n.layer !== undefined && n.layer !== "product" && n.layer !== "build" && n.layer !== "infra" && n.layer !== "correctness") return false;
  return [n.codeRefs, n.realizes, n.hosts, n.verifies].every((entries) => entries === undefined || stringArray(entries));
}

function edge(value: unknown): value is GraphEdge {
  const e = record(value);
  if (e === null || !exactKeys(e, ["id", "source", "target", "kind"], ["label"])) return false;
  if (!nonempty(e.id) || !nonempty(e.source) || !nonempty(e.target)) return false;
  if (!EDGE_KINDS.includes(e.kind as (typeof EDGE_KINDS)[number])) return false;
  return e.label === undefined || typeof e.label === "string";
}

function canvasOp(value: unknown): value is CanvasOp {
  const op = record(value);
  if (op === null || typeof op.op !== "string") return false;
  switch (op.op) {
    case "upsert_node":
      return exactKeys(op, ["op", "node"]) && node(op.node);
    case "remove_node":
    case "remove_edge":
      return exactKeys(op, ["op", "id"]) && nonempty(op.id);
    case "upsert_edge":
      return exactKeys(op, ["op", "edge"]) && edge(op.edge);
    case "set_phase":
      return exactKeys(op, ["op", "id", "phase"]) && nonempty(op.id) && PHASES.includes(op.phase as (typeof PHASES)[number]);
    default:
      return false;
  }
}

function reality(value: unknown): value is RealityLayer {
  const r = record(value);
  if (r === null || !exactKeys(r, ["nodes", "edges", "symbols", "infra", "verification", "extractedAt", "head"])) return false;
  if (!Array.isArray(r.nodes) || !r.nodes.every((value) => {
    const n = record(value);
    return n !== null && exactKeys(n, ["id", "label", "dir"]) && nonempty(n.id) && typeof n.label === "string" && typeof n.dir === "string";
  })) return false;
  if (!Array.isArray(r.edges) || !r.edges.every((value) => {
    const e = record(value);
    return e !== null && exactKeys(e, ["id", "source", "target"]) && nonempty(e.id) && nonempty(e.source) && nonempty(e.target);
  })) return false;
  if (!Array.isArray(r.symbols) || !r.symbols.every((value) => {
    const s = record(value);
    return s !== null && exactKeys(s, ["id", "file", "name", "kind", "exported", "line", "pkg"])
      && nonempty(s.id) && typeof s.file === "string" && nonempty(s.name)
      && (s.kind === "class" || s.kind === "function") && typeof s.exported === "boolean"
      && typeof s.line === "number" && Number.isInteger(s.line) && s.line > 0 && nullableString(s.pkg);
  })) return false;
  if (!Array.isArray(r.infra) || !r.infra.every((value) => {
    const i = record(value);
    return i !== null && exactKeys(i, ["id", "label", "kind", "evidence", "hint"])
      && nonempty(i.id) && typeof i.label === "string" && NODE_KINDS.includes(i.kind as (typeof NODE_KINDS)[number])
      && stringArray(i.evidence) && typeof i.hint === "string";
  })) return false;
  if (!Array.isArray(r.verification) || !r.verification.every((value) => {
    const v = record(value);
    return v !== null && exactKeys(v, ["id", "label", "kind", "evidence", "hint", "covers"])
      && nonempty(v.id) && typeof v.label === "string" && NODE_KINDS.includes(v.kind as (typeof NODE_KINDS)[number])
      && stringArray(v.evidence) && typeof v.hint === "string" && stringArray(v.covers);
  })) return false;
  return nullableString(r.extractedAt) && nullableString(r.head);
}

function failure(value: unknown, message: string): ParsedControlRequest {
  const request = record(value);
  return { error: { requestId: request !== null && typeof request.requestId === "string" ? request.requestId : "", message } };
}

/** Strictly narrow one JSON websocket frame to the public control request union. */
export function parseControlRequest(raw: string): ParsedControlRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: { requestId: "", message: "control request must be valid JSON" } };
  }
  const request = record(parsed);
  if (request === null) return failure(parsed, "control request must be an object");
  if (!nonempty(request.requestId)) return failure(request, "control requestId must be a non-empty string");
  if (typeof request.type !== "string") return failure(request, "control request type must be a string");
  const requestId = request.requestId;

  if (request.type === "control_ping") {
    if (!exactKeys(request, ["type", "requestId"])) return failure(request, "control_ping contains inappropriate fields");
    return { request: { type: "control_ping", requestId } };
  }
  if (request.type !== "map_read" && request.type !== "map_commit" && request.type !== "live_update") {
    return failure(request, `unsupported control operation ${request.type}`);
  }

  const repo = repository(request.repository);
  if (repo === null) return failure(request, "repository must contain non-empty id, label, and path strings");
  if (!branch(request.branch)) return failure(request, "branch must be a full refs/heads/<name> ref");

  if (request.type === "map_read") {
    if (!exactKeys(request, ["type", "requestId", "repository", "branch"])) return failure(request, "map_read contains inappropriate fields");
    return { request: { type: "map_read", requestId, repository: repo, branch: request.branch } };
  }

  if (request.type === "map_commit") {
    if (!exactKeys(request, ["type", "requestId", "repository", "branch", "expectedRevision", "expectedMappedCommit", "commit", "mode", "ops", "reality"], ["note"])) {
      return failure(request, "map_commit has missing or inappropriate fields");
    }
    if (typeof request.expectedRevision !== "number" || !Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) {
      return failure(request, "expectedRevision must be a non-negative integer");
    }
    if (request.expectedMappedCommit !== null && !commitId(request.expectedMappedCommit)) {
      return failure(request, "expectedMappedCommit must be an exact 40- or 64-character hex commit SHA, or null");
    }
    if (!commitId(request.commit)) return failure(request, "commit must be an exact 40- or 64-character hex commit SHA");
    if (request.mode !== "initial" && request.mode !== "incremental" && request.mode !== "full") return failure(request, "mode must be initial, incremental, or full");
    if (!Array.isArray(request.ops) || !request.ops.every(canvasOp)) return failure(request, "ops must be an array of valid canvas operations");
    if (!reality(request.reality)) return failure(request, "reality must be a complete valid reality layer");
    if (request.note !== undefined && typeof request.note !== "string") return failure(request, "note must be a string");
    return {
      request: {
        type: "map_commit",
        requestId,
        repository: repo,
        branch: request.branch,
        expectedRevision: request.expectedRevision,
        expectedMappedCommit: request.expectedMappedCommit,
        commit: request.commit,
        mode: request.mode,
        ops: request.ops,
        reality: request.reality,
        ...(request.note === undefined ? {} : { note: request.note }),
      },
    };
  }

  if (request.type === "live_update") {
    if (!exactKeys(request, ["type", "requestId", "repository", "branch", "sessionId", "state"], ["ops", "note", "tool", "files"])) {
      return failure(request, "live_update has missing or inappropriate fields");
    }
    if (!nonempty(request.sessionId)) return failure(request, "sessionId must be a non-empty string");
    if (request.state !== "start" && request.state !== "working" && request.state !== "idle" && request.state !== "stop") {
      return failure(request, "state must be start, working, idle, or stop");
    }
    if (request.ops !== undefined && (!Array.isArray(request.ops) || !request.ops.every(canvasOp))) return failure(request, "ops must be an array of valid canvas operations");
    if (request.note !== undefined && typeof request.note !== "string") return failure(request, "note must be a string");
    if (request.tool !== undefined && typeof request.tool !== "string") return failure(request, "tool must be a string");
    if (request.files !== undefined && !stringArray(request.files)) return failure(request, "files must be an array of strings");
    return {
      request: {
        type: "live_update",
        requestId,
        repository: repo,
        branch: request.branch,
        sessionId: request.sessionId,
        state: request.state,
        ...(request.ops === undefined ? {} : { ops: request.ops }),
        ...(request.note === undefined ? {} : { note: request.note }),
        ...(request.tool === undefined ? {} : { tool: request.tool }),
        ...(request.files === undefined ? {} : { files: request.files }),
      },
    };
  }

  return failure(request, `unsupported control operation ${request.type}`);
}

function error(requestId: string, message: string): ControlErrorResponse {
  return { type: "control_error", requestId, message, code: "invalid" };
}

/**
 * Bind the request/response discipline to one authenticated control socket.
 * Each received frame produces exactly one correlated response; no tenant or
 * repository authority is read from the frame beyond the mount-provided tenant.
 */
export function handleControlConnection(socket: WebSocket, tenant: string, opts: ControlEndpointOptions): void {
  socket.on("error", (err) => {
    // Error names classify the transport failure without risking a URL/token
    // from an implementation-specific message reaching logs.
    console.error(`[bridge] control socket error (${err.name})`);
  });

  socket.on("message", (data, isBinary) => {
    const byteLength = Array.isArray(data)
      ? data.reduce((total, part) => total + part.byteLength, 0)
      : data.byteLength;
    if (byteLength > MAX_CONTROL_FRAME_BYTES) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(error("", "control request exceeds the 4 MiB frame limit")));
      }
      socket.close(1009, "control frame too large");
      return;
    }
    if (isBinary) {
      socket.send(JSON.stringify(error("", "control requests must be JSON text frames")));
      return;
    }
    const parsed = parseControlRequest(data.toString());
    if (parsed.error !== undefined) {
      socket.send(JSON.stringify(error(parsed.error.requestId, parsed.error.message)));
      return;
    }
    void opts.onRequest(tenant, parsed.request).then(
      (response) => {
        const correlated = response.requestId === parsed.request.requestId
          ? response
          : error(parsed.request.requestId, "control handler returned an uncorrelated response");
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(correlated));
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(error(parsed.request.requestId, message)));
      },
    );
  });
}
