import { BRIDGE_PORT, BRIDGE_WS_PATH, type ClientMsg } from "../../shared/src/index.ts";
import type { PtyClientMsg, PtyServerMsg } from "../../shared/src/pty.ts";
import { isMockMode, mockSend } from "./mock.ts";
import { isRecord, parseServerMsg } from "./parse.ts";
import { useApp } from "./store.ts";

const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}${BRIDGE_WS_PATH}`;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

let socket: WebSocket | null = null;
let retries = 0;
let retryTimer: number | null = null;

/**
 * Terminal frames are their own wire: they carry no graph, arrive in bursts
 * while a shell prints, and are validated here rather than in `parseServerMsg`
 * so a terminal byte never walks through the graph parser.
 */
function asPtyServerMsg(raw: Record<string, unknown>): PtyServerMsg | null {
  switch (raw.type) {
    case "pty_data":
      return typeof raw.data === "string" ? { type: "pty_data", data: raw.data } : null;
    case "pty_exit":
      if (raw.code === null) return { type: "pty_exit", code: null };
      return typeof raw.code === "number" ? { type: "pty_exit", code: raw.code } : null;
    case "pty_state":
      if (typeof raw.open !== "boolean" || typeof raw.shell !== "string" || typeof raw.cwd !== "string") return null;
      return { type: "pty_state", open: raw.open, shell: raw.shell, cwd: raw.cwd };
    default:
      return null;
  }
}

function open(): void {
  const { setConn, ingest, applyPty, pushError } = useApp.getState();
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
    if (isRecord(raw)) {
      const pty = asPtyServerMsg(raw);
      if (pty !== null) {
        applyPty(pty);
        return;
      }
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

/**
 * Terminal input goes only to a real bridge: there is no shell behind the mock
 * graph, and a keystroke arriving while the socket is down is not worth a toast
 * — the pane already says the shell is gone.
 */
export function sendPty(msg: PtyClientMsg): void {
  if (isMockMode() || socket === null || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(msg));
}
