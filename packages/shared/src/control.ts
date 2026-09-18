import type { CanvasOp, GraphDoc, RealityLayer } from "./index.ts";

/** Authenticated server control websocket endpoint. */
export const CONTROL_WS_PATH = "/control";

/** Stable source-side identity and display metadata for a repository. */
export interface RepositoryDescriptor {
  id: string;
  label: string;
  path: string;
}

/** One persistent repository branch shown on the canvas. */
export interface CanvasBranchInfo {
  id: string;
  branch: string;
  head: string | null;
  mappedCommit: string | null;
  live: boolean;
  path: string | null;
  isDefault: boolean;
}

export interface ControlPingRequest {
  type: "control_ping";
  requestId: string;
}

export interface ControlReadyResponse {
  type: "control_ready";
  requestId: string;
  service: "shape";
  protocolVersion: 1;
}

export interface MapReadRequest {
  type: "map_read";
  requestId: string;
  repository: RepositoryDescriptor;
  branch: string;
}

export interface MapStateResponse {
  type: "map_state";
  requestId: string;
  repository: RepositoryDescriptor;
  branch: string;
  revision: number;
  mappedCommit: string | null;
  doc: GraphDoc | null;
}

export type MapMode = "initial" | "incremental" | "full";

export interface MapCommitRequest {
  type: "map_commit";
  requestId: string;
  repository: RepositoryDescriptor;
  branch: string;
  expectedRevision: number;
  expectedMappedCommit: string | null;
  commit: string;
  mode: MapMode;
  ops: CanvasOp[];
  reality: RealityLayer;
  note?: string;
}

export interface MapCommittedResponse {
  type: "map_committed";
  requestId: string;
  projectId: string;
  branch: string;
  revision: number;
  mappedCommit: string;
}

export type LiveState = "start" | "working" | "idle" | "stop";

export interface LiveUpdateRequest {
  type: "live_update";
  requestId: string;
  repository: RepositoryDescriptor;
  branch: string;
  sessionId: string;
  state: LiveState;
  ops?: CanvasOp[];
  note?: string;
  tool?: string;
  files?: string[];
}

export interface LiveUpdatedResponse {
  type: "live_updated";
  requestId: string;
  projectId: string;
  branch: string;
  revision: number;
  mappedCommit: string;
}

export type ControlErrorCode = "conflict" | "invalid" | "not_mapped";

export interface ControlErrorResponse {
  type: "control_error";
  requestId: string;
  message: string;
  code: ControlErrorCode;
}

export type ControlRequest = ControlPingRequest | MapReadRequest | MapCommitRequest | LiveUpdateRequest;

export type ControlResponse =
  | ControlReadyResponse
  | MapStateResponse
  | MapCommittedResponse
  | LiveUpdatedResponse
  | ControlErrorResponse;
