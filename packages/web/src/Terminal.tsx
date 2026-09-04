/**
 * The terminal drawer: one xterm instance bound to the pty the bridge runs for
 * the variation being steered. It is not a view of the project — the canvas is
 * never traded for it. It slides over the bottom of the canvas when the harness
 * runs in Shape's own terminal and the reader asks to go there, and Esc or the
 * close button puts it away again.
 *
 * Two rules shape this component. The instance is created on FIRST SHOW, not on
 * mount — an xterm opened inside `display:none` measures 0×0 and would size the
 * pty to nonsense. And once created it is never torn down while the app lives:
 * hiding the drawer is a CSS change, so scrollback survives every trip back to
 * the canvas.
 */

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { branchOf, NO_WORKTREES, selectPty, selectTarget, setPtySink, useApp } from "./store.ts";
import { sendPty } from "./ws.ts";

/**
 * Terminal colours come from the design system so a shell prompt sits in the
 * same instrument as the canvas: blue-tinted neutrals, one hue per meaning.
 */
const THEME = {
  background: "#12171e",
  foreground: "#e3e8ef",
  cursor: "#dce4f0",
  cursorAccent: "#12171e",
  selectionBackground: "#2b3648",
  black: "#1b222c",
  red: "#f4726f",
  green: "#4bcf85",
  yellow: "#f2b03c",
  blue: "#5fa8fa",
  magenta: "#a98bf5",
  cyan: "#62d4d0",
  white: "#c8d1de",
  brightBlack: "#6b7686",
  brightRed: "#ff9a97",
  brightGreen: "#79e0a6",
  brightYellow: "#ffc966",
  brightBlue: "#8cc3ff",
  brightMagenta: "#c7aefc",
  brightCyan: "#8ee6e2",
  brightWhite: "#f2f5fa",
};

export function TerminalPane() {
  const open = useApp((state) => state.terminalOpen);
  const setTerminal = useApp((state) => state.setTerminal);
  /**
   * One drawer, one shell: it is the target variation's terminal, so switching
   * the steering target switches what is on screen. The store already drops
   * bytes from any other variation.
   */
  const target = useApp(selectTarget);
  const pty = useApp(selectPty);
  const exited = pty.exited;
  const shell = pty.shell;
  const cwd = pty.cwd;
  const conn = useApp((state) => state.conn);
  const worktrees = useApp((state) => state.session?.worktrees ?? NO_WORKTREES);
  // one variation is just "the project", and its branch would say nothing new
  const branch = target === null || worktrees.length < 2 ? null : branchOf(worktrees, target);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** read inside the xterm callbacks, which outlive any one render */
  const targetRef = useRef(target);
  targetRef.current = target;
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => setTerminal(false);
  /** which variation's shell the scrollback on screen belongs to */
  const shownRef = useRef<string | null>(null);
  /** collected at creation, run only when the app itself goes away */
  const teardownRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open) return;
    const host = hostRef.current;
    if (host === null) return;

    const existing = termRef.current;
    if (existing !== null) {
      // the drawer was hidden while the window changed size
      fitRef.current?.fit();
      existing.focus();
      return;
    }

    const term = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", "Berkeley Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      smoothScrollDuration: 0,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // bytes bypass React entirely; see PtyView in store.ts
    setPtySink((data) => term.write(data));
    const input = term.onData((data) => {
      const worktree = targetRef.current;
      if (worktree === null) return;
      sendPty({ type: "pty_input", worktree, data });
    });
    // `fit` resizes the terminal, so this is also how a window resize reaches
    // the pty — one source of truth for the size we report
    const resized = term.onResize(({ cols, rows }) => {
      const worktree = targetRef.current;
      if (worktree === null) return;
      sendPty({ type: "pty_resize", worktree, cols, rows });
    });
    /**
     * Esc puts the drawer away rather than reaching the shell. The drawer is
     * something the app opened over the canvas, so the key that dismisses every
     * other overlay has to dismiss this one too — a reader who cannot get back
     * to the canvas without hunting for a button is stuck in a pane they only
     * meant to glance at.
     */
    term.attachCustomKeyEventHandler((event) => {
      if (event.key !== "Escape") return true;
      if (event.type === "keydown") closeRef.current();
      return false;
    });

    const observer = new ResizeObserver(() => {
      // a hidden drawer measures 0×0 and would fit the pty to a single cell
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
    });
    observer.observe(host);

    term.focus();

    teardownRef.current = () => {
      observer.disconnect();
      input.dispose();
      resized.dispose();
      setPtySink(null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      teardownRef.current = null;
    };
  }, [open]);

  // the only teardown: putting the drawer away must not cost the scrollback
  useEffect(() => () => teardownRef.current?.(), []);

  // Esc reaches the drawer even when nothing inside it has focus — it can be
  // opened without the pointer ever entering it.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      setTerminal(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setTerminal]);

  /**
   * Opening the drawer is a request that can be lost: `pty_open` is dropped
   * silently when the socket is not up (the drawer shown before the first
   * connect, or a bridge that restarted under a tab left open), and nothing
   * else ever asks — which is exactly how the drawer ends up blank forever. So
   * the ask is tied to the connection, not to one moment: every time this page
   * has both a drawer and a live bridge, it asks again. A second open costs
   * nothing — the bridge answers with the terminal it already has.
   *
   * It is tied to the target variation too, because the drawer is that
   * variation's shell: switching target asks its shell to draw, and the
   * scrollback of the one before is cleared rather than left above it as if
   * both were the same session.
   */
  useEffect(() => {
    if (!open || conn !== "live" || target === null) return;
    const term = termRef.current;
    if (term === null) return;
    if (shownRef.current !== null && shownRef.current !== target) term.clear();
    shownRef.current = target;
    sendPty({ type: "pty_open", worktree: target, cols: term.cols, rows: term.rows });
  }, [open, conn, target]);

  const restart = (): void => {
    const term = termRef.current;
    if (term === null || target === null) return;
    term.clear();
    sendPty({ type: "pty_open", worktree: target, cols: term.cols, rows: term.rows });
    term.focus();
  };

  return (
    <section
      className="term"
      style={{ display: open ? "flex" : "none" }}
      aria-hidden={!open}
      aria-label="terminal"
    >
      <div className="term-head">
        <span className="term-title">terminal</span>
        {/* whose shell this is: with several variations open, a prompt with no
            branch on it is a prompt in an unknown checkout */}
        {branch === null ? null : <span className="term-branch">{branch}</span>}
        <span className="term-where mono">{cwd.length === 0 ? "not attached" : cwd}</span>
        <span className="term-shell mono">{shell.length === 0 ? "" : shell}</span>
        <span className="term-hint">
          <kbd>Esc</kbd> hides it
        </span>
        <button
          type="button"
          className="term-close"
          onClick={() => setTerminal(false)}
          title="back to the canvas — the session keeps running"
          aria-label="hide the terminal"
        >
          ×
        </button>
      </div>
      <div className="term-body">
        <div className="term-host" ref={hostRef} />
        {conn === "live" ? null : (
          <div className="term-veil" role="status">
            {conn === "mock"
              ? "the terminal needs a live bridge — this page is showing the sample graph"
              : "waiting for the bridge"}
          </div>
        )}
        {conn !== "live" || exited === null ? null : (
          <button type="button" className="term-veil term-veil-action" onClick={restart}>
            shell exited{exited.code === null ? "" : ` (${exited.code})`} — click to restart
          </button>
        )}
      </div>
    </section>
  );
}
