import { BRIDGE_PORT, BRIDGE_WS_PATH, type ClientMsg } from "../../shared/src/index.ts";
import { isMockMode, mockSend } from "./mock.ts";
import { parseServerMsg } from "./parse.ts";
import { useApp } from "./store.ts";

/** the on-prem deployment hands these to the page once; they outlive the URL */
const TOKEN_KEY = "shape.token";
const SERVER_KEY = "shape.server";
const TOKEN_SERVER_KEY = "shape.tokenServer";
const DEV_SERVER = `127.0.0.1:${BRIDGE_PORT}`;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

let socket: WebSocket | null = null;
let retries = 0;
let retryTimer: number | null = null;

/**
 * A remote deployment can hand credentials to the canvas in the fragment (or,
 * for compatibility, the query). A fragment containing either field wins as
 * one atomic handoff. Consume both locations before app code can expose them.
 */
function captureUrlCredentials(): void {
  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const queryHasCredentials = query.has("token") || query.has("server");
  const fragmentHasCredentials = fragment.has("token") || fragment.has("server");
  if (!queryHasCredentials && !fragmentHasCredentials) return;

  // Never combine a fragment server with a legacy query token: credentials in
  // one handoff location are an atomic set, and the fragment takes precedence.
  const source = fragmentHasCredentials ? fragment : query;
  const token = source.get("token");
  const serverOverride = source.get("server");
  try {
    const previousServer = window.localStorage.getItem(SERVER_KEY);
    const selectedServer =
      serverOverride !== null
        ? normalizeServer(serverOverride)
        : token !== null
          ? environmentServer()
          : normalizeServer(previousServer ?? "") ?? environmentServer();
    if (serverOverride !== null) {
      // An invalid override falls back to the environment, but must not make a
      // token previously bound to that fallback eligible for forwarding.
      if (selectedServer === null) window.localStorage.removeItem(TOKEN_SERVER_KEY);
      window.localStorage.setItem(SERVER_KEY, selectedServer ?? serverOverride);
    } else if (token !== null && selectedServer !== null) {
      // A token by itself always means this page's default endpoint. Reaching a
      // persisted remote destination requires that server in the same handoff.
      window.localStorage.setItem(SERVER_KEY, selectedServer);
    }
    if (token !== null && selectedServer !== null) {
      // The binding is removed first and written last. If storage fails partway
      // through, bridgeUrl cannot send this token to any origin.
      window.localStorage.removeItem(TOKEN_SERVER_KEY);
      if (credentialEndpointIsSafe(selectedServer)) {
        window.localStorage.setItem(TOKEN_KEY, token);
        window.localStorage.setItem(TOKEN_SERVER_KEY, selectedServer);
      }
    }
  } catch {
    // Storage can be unavailable; URL cleanup must still happen.
  }

  query.delete("token");
  query.delete("server");
  fragment.delete("token");
  fragment.delete("server");
  const search = queryHasCredentials
    ? query.size === 0
      ? ""
      : `?${query.toString()}`
    : window.location.search;
  const hash = fragmentHasCredentials
    ? fragment.size === 0
      ? ""
      : `#${fragment.toString()}`
    : window.location.hash;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${hash}`);
}

captureUrlCredentials();

function normalizeServer(server: string): string | null {
  const value = server.trim();
  if (value === "") return null;

  try {
    const url = value.startsWith("//")
      ? new URL(`${window.location.protocol === "https:" ? "https:" : "http:"}${value}`)
      : /^(?:https?|wss?):/i.test(value)
        ? new URL(value)
        : new URL(`http://${value}`);
    const protocol =
      url.protocol === "https:" || url.protocol === "wss:"
        ? "wss:"
        : url.protocol === "http:" || url.protocol === "ws:"
          ? "ws:"
          : null;
    return protocol === null || url.host === "" ? null : `${protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function environmentServer(): string {
  if (import.meta.env.DEV) return `ws://${DEV_SERVER}`;
  return normalizeServer(window.location.origin) ?? `ws://${DEV_SERVER}`;
}

function selectedServer(): string {
  try {
    return normalizeServer(window.localStorage.getItem(SERVER_KEY) ?? "") ?? environmentServer();
  } catch {
    return environmentServer();
  }
}

function credentialEndpointIsSafe(server: string): boolean {
  const url = new URL(server);
  if (url.protocol === "wss:") return true;
  if (url.protocol !== "ws:") return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function bridgeUrl(): string {
  const server = selectedServer();
  let storedToken = "";
  let tokenServer: string | null = null;
  try {
    storedToken = window.localStorage.getItem(TOKEN_KEY) ?? "";
    tokenServer = window.localStorage.getItem(TOKEN_SERVER_KEY);
  } catch {
    // Reconnecting must still work when storage becomes unavailable.
  }
  const token = tokenServer === server && credentialEndpointIsSafe(server) ? storedToken : "";
  const auth = token === "" ? "" : `?token=${encodeURIComponent(token)}`;
  return `${server}${BRIDGE_WS_PATH}${auth}`;
}

function open(): void {
  const { setConn, ingest, pushError } = useApp.getState();
  // first attempt reads as "connecting"; every later one means we lost it
  setConn(retries === 0 ? "connecting" : "lost");

  const ws = new WebSocket(bridgeUrl());
  socket = ws;

  ws.addEventListener("open", () => {
    if (socket !== ws) return;
    retries = 0;
    setConn("live");
  });

  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
    if (typeof event.data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      pushError("bridge sent a non-JSON frame");
      return;
    }
    const msg = parseServerMsg(raw);
    if (msg === null) {
      pushError("bridge sent a frame this client could not validate");
      return;
    }
    ingest(msg);
  });

  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    socket = null;
    setConn("lost");
    if (retryTimer !== null) return;
    const delay = Math.min(BACKOFF_MIN_MS * 2 ** retries, BACKOFF_MAX_MS);
    retries += 1;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      open();
    }, delay);
  });

  // a failed connect always emits `close` too, where reconnection is handled
  ws.addEventListener("error", () => {});
}

function reconnect(): void {
  if (isMockMode()) return;
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  retries = 0;
  const previous = socket;
  socket = null;
  if (previous !== null) {
    try {
      previous.close();
    } catch {
      // Its guarded listeners cannot affect the replacement connection.
    }
  }
  open();
}

/** The selected browser socket endpoint, safe to display (never includes credentials). */
export function getBridgeEndpoint(): string {
  return `${selectedServer()}${BRIDGE_WS_PATH}`;
}

/**
 * Persist a token for exactly the selected endpoint and reconnect immediately.
 * Plaintext credentials are only allowed through a loopback/SSH-tunnel target.
 */
export function setBridgeToken(token: string): void {
  const server = selectedServer();
  if (token !== "" && !credentialEndpointIsSafe(server)) {
    throw new Error("credentials require HTTPS/WSS or a loopback SSH tunnel");
  }
  try {
    window.localStorage.removeItem(TOKEN_SERVER_KEY);
    if (token === "") {
      window.localStorage.removeItem(TOKEN_KEY);
    } else {
      window.localStorage.setItem(TOKEN_KEY, token);
      window.localStorage.setItem(TOKEN_SERVER_KEY, server);
    }
  } catch {
    try {
      window.localStorage.removeItem(TOKEN_SERVER_KEY);
    } catch {
      // Best effort: without the binding, a stored token is never forwarded.
    }
    throw new Error("could not store the bridge credential");
  }
  reconnect();
}

/** idempotent; safe to call from an effect that may run twice */
export function connectBridge(): void {
  if (isMockMode()) {
    useApp.getState().setConn("mock");
    return;
  }
  if (socket !== null) return;
  open();
}

export function send(msg: ClientMsg): boolean {
  if (isMockMode()) {
    mockSend(msg);
    return true;
  }
  if (socket === null || socket.readyState !== WebSocket.OPEN) {
    useApp.getState().pushError("not connected to the bridge — nothing was sent");
    return false;
  }
  socket.send(JSON.stringify(msg));
  return true;
}
