import { BRIDGE_PORT, BRIDGE_WS_PATH, type ClientMsg } from "../../shared/src/index.ts";
import { isMockMode, mockSend } from "./mock.ts";
import { parseServerMsg } from "./parse.ts";
import { useApp } from "./store.ts";

/** the on-prem deployment hands these to the page once; they outlive the URL */
const TOKEN_KEY = "shape.token";
const SERVER_KEY = "shape.server";
const DEFAULT_SERVER = `127.0.0.1:${BRIDGE_PORT}`;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

let socket: WebSocket | null = null;
let retries = 0;
let retryTimer: number | null = null;

/**
 * A remote deployment opens the canvas with `?server=host:port&token=…`. Both
 * are captured once at startup — before the app decides whether it is in mock
 * mode, so any entry path swallows the credentials — and kept in localStorage
 * so a reload, or a bookmark that lost the query, still reaches the same
 * server. Both are stripped from the visible URL so a link copied out of the
 * address bar carries no token.
 */
function captureUrlCredentials(): void {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const server = params.get("server");
  if (token === null && server === null) return;
  if (token !== null) window.localStorage.setItem(TOKEN_KEY, token);
  if (server !== null) window.localStorage.setItem(SERVER_KEY, server);
  params.delete("token");
  params.delete("server");
  const query = params.toString();
  const rest = query === "" ? "" : `?${query}`;
  window.history.replaceState(null, "", `${window.location.pathname}${rest}${window.location.hash}`);
}

captureUrlCredentials();

function bridgeUrl(): string {
  const server = window.localStorage.getItem(SERVER_KEY) || DEFAULT_SERVER;
  const token = window.localStorage.getItem(TOKEN_KEY) || "";
  const auth = token === "" ? "" : `?token=${encodeURIComponent(token)}`;
  return `ws://${server}${BRIDGE_WS_PATH}${auth}`;
}

function open(): void {
  const { setConn, ingest, pushError } = useApp.getState();
  // first attempt reads as "connecting"; every later one means we lost it
  setConn(retries === 0 ? "connecting" : "lost");

  const ws = new WebSocket(bridgeUrl());
  socket = ws;

  ws.addEventListener("open", () => {
    retries = 0;
    setConn("live");
  });

  ws.addEventListener("message", (event) => {
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
    if (socket === ws) socket = null;
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

/** idempotent; safe to call from an effect that may run twice */
export function connectBridge(): void {
  if (isMockMode()) {
    useApp.getState().setConn("mock");
    return;
  }
  if (socket !== null) return;
  open();
}

export function send(msg: ClientMsg): void {
  if (isMockMode()) {
    mockSend(msg);
    return;
  }
  if (socket === null || socket.readyState !== WebSocket.OPEN) {
    useApp.getState().pushError("not connected to the bridge — nothing was sent");
    return;
  }
  socket.send(JSON.stringify(msg));
}
