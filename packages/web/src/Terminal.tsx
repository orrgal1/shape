/**
 * The terminal pane: one xterm instance bound to the bridge's single shell.
 *
 * Two rules shape this component. The instance is created on FIRST SHOW, not on
 * mount — an xterm opened inside `display:none` measures 0×0 and would size the
 * pty to nonsense. And once created it is never torn down while the app lives:
 * hiding the pane is a CSS change, so scrollback survives every trip to the
 * canvas and back.
 */

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { setPtySink, useApp } from "./store.ts";
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
  const terminalOpen = useApp((state) => state.terminalOpen);
  const exited = useApp((state) => state.pty.exited);
  const shell = useApp((state) => state.pty.shell);
  const cwd = useApp((state) => state.pty.cwd);
  const conn = useApp((state) => state.conn);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** collected at creation, run only when the app itself goes away */
  const teardownRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!terminalOpen) return;
    const host = hostRef.current;
    if (host === null) return;

    const existing = termRef.current;
    if (existing !== null) {
      // the pane was hidden while the window changed size
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
    const input = term.onData((data) => sendPty({ type: "pty_input", data }));
    // `fit` resizes the terminal, so this is also how a window resize reaches
    // the pty — one source of truth for the size we report
    const resized = term.onResize(({ cols, rows }) => sendPty({ type: "pty_resize", cols, rows }));
    // Ctrl+` is the app's view switch, not a keystroke for the shell
    term.attachCustomKeyEventHandler((event) => !(event.ctrlKey && event.key === "`"));

    const observer = new ResizeObserver(() => {
      // a hidden pane measures 0×0 and would fit the pty to a single cell
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
    });
    observer.observe(host);

    sendPty({ type: "pty_open", cols: term.cols, rows: term.rows });
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
  }, [terminalOpen]);

  // the only teardown: toggling the pane away must not cost the scrollback
  useEffect(() => () => teardownRef.current?.(), []);

  const restart = (): void => {
    const term = termRef.current;
    if (term === null) return;
    term.clear();
    sendPty({ type: "pty_open", cols: term.cols, rows: term.rows });
    term.focus();
  };

  return (
    <section className="term" style={{ display: terminalOpen ? "flex" : "none" }} aria-hidden={!terminalOpen}>
      <div className="term-head">
        <span className="term-title">terminal</span>
        <span className="term-where mono">{cwd.length === 0 ? "not attached" : cwd}</span>
        <span className="term-shell mono">{shell.length === 0 ? "" : shell}</span>
        <span className="term-hint">
          <kbd>Ctrl</kbd>+<kbd>`</kbd>
        </span>
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
        {conn === "live" && exited !== null ? (
          <button type="button" className="term-veil term-veil-action" onClick={restart}>
            shell exited{exited.code === null ? "" : ` (${exited.code})`} — click to restart
          </button>
        ) : null}
      </div>
    </section>
  );
}
