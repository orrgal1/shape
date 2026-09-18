/**
 * Focused control websocket smoke: mount authentication, browser exclusion,
 * request correlation, and malformed input stopping before storage.
 *
 * Run: node --test packages/bridge/src/server/control.test.ts
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import WebSocket from "ws";
import type { MapCommitRequest } from "../../../shared/src/index.ts";
import { ShapeServer } from "./server.ts";
import type { Storage, StoredProject } from "./storage.ts";
import { SocketServer } from "../wsserver.ts";

const EMPTY_REALITY = {
  nodes: [],
  edges: [],
  symbols: [],
  infra: [],
  verification: [],
  extractedAt: null,
  head: null,
};

const TOKEN = "0123456789abcdef0123456789abcdef";

async function unusedPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert(address !== null && typeof address === "object");
  const port = address.port;
  probe.close();
  await once(probe, "close");
  return port;
}

async function rejectedStatus(url: string, headers: Record<string, string>): Promise<number> {
  const socket = new WebSocket(url, { headers });
  const status = await new Promise<number>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => reject(new Error("control websocket was unexpectedly admitted")));
    socket.once("error", () => {});
  });
  socket.terminate();
  return status;
}

async function response(socket: WebSocket, request: unknown): Promise<unknown> {
  const received = once(socket, "message");
  socket.send(JSON.stringify(request));
  const [data] = await received;
  return JSON.parse(data.toString()) as unknown;
}

test("control websocket authenticates tooling, rejects browser origins, and validates before storage", async (t) => {
  const port = await unusedPort();
  const sockets = new SocketServer({ port });
  let reads = 0;
  let saves = 0;
  const storage = {
    file: ":memory:",
    listBranches: async () => [],
    readBranch: async () => {
      reads++;
      return null;
    },
    saveProject: async () => {
      saves++;
    },
    mapCommit: async (_tenant: string, request: MapCommitRequest, _project?: StoredProject) => ({
      type: "control_error",
      requestId: request.requestId,
      message: "semantic rejection",
      code: "invalid",
    }),
  } as unknown as Storage;
  new ShapeServer({
    sockets,
    storage,
    auth: { tenantOf: (token) => token === TOKEN ? "tenant-a" : null },
  });
  await sockets.listen();
  t.after(() => sockets.close());

  const url = sockets.url("/control");
  assert.equal(await rejectedStatus(url, { Authorization: `Bearer ${TOKEN}`, Origin: "https://canvas.example" }), 401);
  assert.equal(await rejectedStatus(url, { Authorization: "Bearer wrong-token-value" }), 401);

  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  await once(socket, "open");
  t.after(() => socket.close());

  assert.deepEqual(await response(socket, { type: "control_ping", requestId: "ping-1" }), {
    type: "control_ready",
    requestId: "ping-1",
    service: "shape",
    protocolVersion: 1,
  });

  assert.deepEqual(await response(socket, {
    type: "map_read",
    requestId: "bad-branch",
    repository: { id: "repo-id", label: "Repo", path: "/source/machine/repo" },
    branch: "main",
  }), {
    type: "control_error",
    requestId: "bad-branch",
    message: "branch must be a full refs/heads/<name> ref",
    code: "invalid",
  });
  assert.equal(reads, 0);

  assert.deepEqual(await response(socket, {
    type: "map_commit",
    requestId: "bad-commit",
    repository: { id: "repo-id", label: "Repo", path: "/source/machine/repo" },
    branch: "refs/heads/main",
    expectedRevision: 0,
    expectedMappedCommit: null,
    commit: "not-a-sha",
    mode: "initial",
    ops: [],
    reality: EMPTY_REALITY,
  }), {
    type: "control_error",
    requestId: "bad-commit",
    message: "commit must be an exact 40- or 64-character hex commit SHA",
    code: "invalid",
  });

  assert.deepEqual(await response(socket, {
    type: "map_commit",
    requestId: "rejected-map",
    repository: { id: "repo-id", label: "Repo", path: "/source/machine/repo" },
    branch: "refs/heads/main",
    expectedRevision: 0,
    expectedMappedCommit: null,
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mode: "initial",
    ops: [],
    reality: EMPTY_REALITY,
  }), {
    type: "control_error",
    requestId: "rejected-map",
    message: "semantic rejection",
    code: "invalid",
  });
  assert.equal(saves, 0);

  assert.deepEqual(await response(socket, {
    type: "live_update",
    requestId: "unmapped-live",
    repository: { id: "repo-id", label: "Repo", path: "/source/machine/repo" },
    branch: "refs/heads/main",
    sessionId: "session-1",
    state: "start",
  }), {
    type: "control_error",
    requestId: "unmapped-live",
    message: "branch refs/heads/main is not mapped; run shape map first",
    code: "not_mapped",
  });
  assert.equal(saves, 0);
  assert.deepEqual(await response(socket, {
    type: "map_read",
    requestId: "read-1",
    repository: { id: "repo-id", label: "Repo", path: "/source/machine/repo" },
    branch: "refs/heads/main",
  }), {
    type: "map_state",
    requestId: "read-1",
    repository: { id: "repo-id", label: "Repo", path: "/source/machine/repo" },
    branch: "refs/heads/main",
    revision: 0,
    mappedCommit: null,
    doc: null,
  });
  assert.equal(reads, 2);
});
