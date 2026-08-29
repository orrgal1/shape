import { BRIDGE_PORT, BRIDGE_WS_PATH, type ClientMsg } from "../../shared/src/index.ts";
import { isMockMode, mockSend } from "./mock.ts";
import { parseServerMsg } from "./parse.ts";
import { useApp } from "./store.ts";

const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}${BRIDGE_WS_PATH}`;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

let socket: WebSocket | null = null;
let retries = 0;
let retryTimer: number | null = null;

function open(): void {
  const { setConn, ingest, pushError } = useApp.getState();
  // first attempt reads as "connecting"; every later one means we lost it
  setConn(retries === 0 ? "connecting" : "lost");

  const ws = new WebSocket(BRIDGE_URL);
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
