import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const DEFAULT_SERVER = "http://127.0.0.1:4400";
const SELECTED_KEY = "$selected";
const CONTROL_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_500;
const SECRET_MODE = 0o600;

export function shapeHome() {
  const configured = process.env.SHAPE_HOME;
  if (configured === undefined) return join(homedir(), ".shape");
  if (configured.trim().length === 0 || !isAbsolute(configured)) {
    throw new Error("SHAPE_HOME must be an absolute directory");
  }
  return join(configured, ".shape");
}

function serversFile() {
  return join(shapeHome(), "servers.json");
}

export function normalizeServer(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("Shape server must be a non-empty origin");
  }

  const value = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^(?:https?|wss?):\/\//i.test(value)) {
    throw new Error("unsupported Shape server scheme; expected http, https, ws, or wss");
  }
  const withScheme = /^(?:https?|wss?):\/\//i.test(value) ? value : `http://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("invalid Shape server origin");
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error("unsupported Shape server scheme; expected http, https, ws, or wss");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Shape server origins must not contain credentials");
  }
  if (url.hostname.length === 0) throw new Error("invalid Shape server origin");

  url.protocol = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
  return url.origin;
}

function websocketOrigin(server) {
  const url = new URL(normalizeServer(server));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

function isLoopback(server) {
  const hostname = new URL(server).hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return match !== null && match.slice(1).every((part) => Number(part) <= 255);
}

function assertCredentialTransport(connection) {
  if (connection.token !== undefined && new URL(connection.server).protocol !== "https:" && !isLoopback(connection.server)) {
    throw controlError(
      "refusing to send a Shape token over plain HTTP to a non-loopback server; use HTTPS or an SSH loopback tunnel",
      "INSECURE_TRANSPORT",
    );
  }
}

async function readStore() {
  const file = serversFile();
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`cannot read saved Shape connections at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`saved Shape connections at ${file} are not valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`saved Shape connections at ${file} must be a JSON object`);
  }
  return value;
}

function savedServer(store) {
  const selected = store[SELECTED_KEY];
  if (selected === null || typeof selected !== "object" || Array.isArray(selected)) return undefined;
  return typeof selected.server === "string" && selected.server.trim().length > 0 ? selected.server : undefined;
}

function savedToken(store, server) {
  const entry = store[websocketOrigin(server)];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  return typeof entry.token === "string" && entry.token.length > 0 ? entry.token : undefined;
}

function nonEmptyToken(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Shape token must be a string");
  const token = value.trim();
  if (token.length === 0) throw new Error("Shape token must not be empty");
  return token;
}
function exactConnection(connection) {
  if (connection === null || typeof connection !== "object" || Array.isArray(connection)) {
    throw new Error("Shape connection must be an object");
  }
  const server = normalizeServer(connection.server);
  const token = nonEmptyToken(connection.token);
  return token === undefined ? { server } : { server, token };
}

export async function resolveConnection({ server, token } = {}) {
  const store = await readStore();
  const explicitServer = server === undefined ? undefined : normalizeServer(server);
  const envServer = process.env.SHAPE_SERVER?.trim();
  const resolvedServer = explicitServer ?? (envServer ? normalizeServer(envServer) : undefined) ??
    (savedServer(store) === undefined ? DEFAULT_SERVER : normalizeServer(savedServer(store)));

  const explicitToken = nonEmptyToken(token);
  const envToken = process.env.SHAPE_TOKEN?.trim();
  const resolvedToken = explicitToken ?? (envToken ? envToken : undefined) ?? savedToken(store, resolvedServer);
  return resolvedToken === undefined
    ? { server: resolvedServer }
    : { server: resolvedServer, token: resolvedToken };
}

async function atomicWriteSecret(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", SECRET_MODE);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await chmod(file, SECRET_MODE);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function saveConnection(connection) {
  const normalized = exactConnection(connection);
  const { server, token } = normalized;
  assertCredentialTransport(normalized);

  const store = await readStore();
  store[SELECTED_KEY] = { server };
  const key = websocketOrigin(server);
  const old = store[key];
  if (token !== undefined) {
    store[key] = old !== null && typeof old === "object" && !Array.isArray(old)
      ? { ...old, token }
      : { token };
  } else if (old !== null && typeof old === "object" && !Array.isArray(old)) {
    const { token: _discarded, ...rest } = old;
    if (Object.keys(rest).length === 0) delete store[key];
    else store[key] = rest;
  }
  const file = serversFile();
  await atomicWriteSecret(file, `${JSON.stringify(store, null, 2)}\n`);
  return file;
}

function websocketConstructor() {
  try {
    const require = createRequire(new URL("../../packages/bridge/package.json", import.meta.url));
    return require("ws");
  } catch {
    throw new Error("Shape dependencies are missing; run pnpm install in the Shape checkout");
  }
}

function controlError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export async function requestControl(request, connection) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("control request must be an object");
  }
  if (typeof request.type !== "string" || request.type.length === 0) {
    throw new Error("control request type must be a non-empty string");
  }
  if (request.requestId !== undefined && (typeof request.requestId !== "string" || request.requestId.length === 0)) {
    throw new Error("control request requestId must be a non-empty string");
  }

  const resolved = connection === undefined ? await resolveConnection() : exactConnection(connection);
  assertCredentialTransport(resolved);
  const requestId = request.requestId ?? randomUUID();
  const frame = { ...request, requestId };
  const url = new URL("/control", websocketOrigin(resolved.server));
  const WebSocket = await websocketConstructor();

  return await new Promise((resolve, reject) => {
    const options = resolved.token === undefined
      ? { handshakeTimeout: CONTROL_TIMEOUT_MS }
      : { handshakeTimeout: CONTROL_TIMEOUT_MS, headers: { Authorization: `Bearer ${resolved.token}` } };
    const socket = new WebSocket(url, options);
    let settled = false;
    const timer = setTimeout(() => finishReject(controlError("Shape control request timed out", "TIMEOUT")), CONTROL_TIMEOUT_MS);
    timer.unref?.();

    const closeSocket = () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        if (socket.readyState === WebSocket.OPEN) socket.close(1000);
        else socket.terminate();
      }
      const force = setTimeout(() => socket.terminate(), 100);
      force.unref?.();
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSocket();
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSocket();
      reject(error);
    };

    socket.once("open", () => {
      try {
        socket.send(JSON.stringify(frame));
      } catch (error) {
        finishReject(controlError(
          `cannot send Shape control request: ${error instanceof Error ? error.message : String(error)}`,
          "CONNECTION_FAILED",
        ));
      }
    });
    socket.on("message", (data) => {
      let response;
      try {
        response = JSON.parse(data.toString());
      } catch {
        finishReject(controlError("Shape control returned invalid JSON", "PROTOCOL_ERROR"));
        return;
      }
      if (response === null || typeof response !== "object" || response.requestId !== requestId) return;
      if (response.type === "control_error") {
        finishReject(controlError(
          typeof response.message === "string" ? response.message : "Shape control request failed",
          typeof response.code === "string" ? response.code : "CONTROL_ERROR",
        ));
        return;
      }
      finishResolve(response);
    });
    socket.once("unexpected-response", (_request, response) => {
      const statusCode = response.statusCode ?? 0;
      response.destroy();
      finishReject(controlError(
        statusCode === 401 ? "Shape server requires a valid token" : `Shape control upgrade failed with HTTP ${statusCode}`,
        statusCode === 401 ? "AUTH_REQUIRED" : "UPGRADE_FAILED",
        { statusCode },
      ));
    });
    socket.once("error", (error) => finishReject(controlError(
      `cannot connect to Shape control endpoint: ${error instanceof Error ? error.message : String(error)}`,
      "CONNECTION_FAILED",
    )));
    socket.once("close", () => {
      if (!settled) finishReject(controlError("Shape control connection closed before replying", "CONNECTION_CLOSED"));
    });
  });
}

export async function connectionCandidates(explicitServers = []) {
  const store = await readStore();
  const candidates = new Map();
  const add = (raw, source) => {
    if (raw === undefined || raw === null || String(raw).trim().length === 0) return;
    const server = normalizeServer(String(raw));
    const existing = candidates.get(server);
    if (existing === undefined) candidates.set(server, { server, sources: [source] });
    else if (!existing.sources.includes(source)) existing.sources.push(source);
  };

  const envServerRaw = process.env.SHAPE_SERVER?.trim();
  const environmentServer = envServerRaw ? normalizeServer(envServerRaw) : undefined;
  const environmentToken = process.env.SHAPE_TOKEN?.trim() || undefined;
  for (const server of explicitServers) add(server, "explicit");
  add(environmentServer, "environment");
  add(savedServer(store), "saved-selected");
  for (const key of Object.keys(store)) {
    if (key === SELECTED_KEY || !/^(?:ws|wss):\/\//i.test(key)) continue;
    try {
      add(key, "saved-credential");
    } catch {
      // Preserve invalid legacy/foreign records, but they are not probe candidates.
    }
  }
  add(DEFAULT_SERVER, "default");

  return [...candidates.values()].map((candidate) => {
    const token = candidate.server === environmentServer && environmentToken !== undefined
      ? environmentToken
      : savedToken(store, candidate.server);
    return {
      ...candidate,
      connection: token === undefined ? { server: candidate.server } : { server: candidate.server, token },
    };
  });
}

export async function probeConnection(connection, { timeout = PROBE_TIMEOUT_MS } = {}) {
  const resolved = connection === undefined ? await resolveConnection() : exactConnection(connection);
  const healthUrl = new URL("/api/health", resolved.server);
  let response;
  try {
    response = await fetch(healthUrl, { signal: AbortSignal.timeout(timeout), redirect: "manual" });
  } catch (error) {
    return {
      server: resolved.server,
      status: "unreachable",
      message: error?.name === "TimeoutError" ? "health probe timed out" : "connection failed",
    };
  }

  let health;
  try {
    health = await response.json();
  } catch {
    health = null;
  }
  if (!response.ok || health?.service !== "shape" || health?.protocolVersion !== 1) {
    return { server: resolved.server, status: "wrong-service", message: "health response is not Shape protocol 1" };
  }

  try {
    const ready = await requestControl({ type: "control_ping" }, resolved);
    if (ready?.type !== "control_ready" || ready?.service !== "shape" || ready?.protocolVersion !== 1) {
      return { server: resolved.server, status: "wrong-service", message: "control response is not Shape protocol 1" };
    }
    return { server: resolved.server, status: "reachable", protocolVersion: 1 };
  } catch (error) {
    if (error?.code === "AUTH_REQUIRED") {
      return { server: resolved.server, status: "auth-required", protocolVersion: 1, message: "valid token required" };
    }
    if (error?.code === "INSECURE_TRANSPORT") {
      return {
        server: resolved.server,
        status: "auth-required",
        protocolVersion: 1,
        message: "token was not sent over insecure transport; use HTTPS or an SSH loopback tunnel",
      };
    }
    return {
      server: resolved.server,
      status: "wrong-service",
      protocolVersion: 1,
      message: "Shape health is present but the control endpoint is unavailable",
    };
  }
}
