import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import type { WorktreeInfo } from "../../shared/src/index.ts";
import { Compare } from "./Compare.tsx";
import { SidePanel } from "./SidePanel.tsx";
import { SteeringBar } from "./SteeringBar.tsx";
import { TerminalPane } from "./Terminal.tsx";
import { Canvas } from "./canvas/Canvas.tsx";
import { useDismissable } from "./dismiss.ts";
import { selectLayer, selectReality } from "./layer.ts";
import { isMockMode, startMock } from "./mock.ts";
import { useApp, type ConnStatus } from "./store.ts";
import { connectBridge, send } from "./ws.ts";

const CONN_LABEL: Record<ConnStatus, string> = {
  connecting: "connecting",
  live: "live",
  lost: "reconnecting",
  mock: "mock data",
};

const PHASE_LEGEND: readonly string[] = ["idea", "concept", "component", "building", "built", "failed"];

/** arrow markers live in CSS so edge colour stays in the design system */
function EdgeMarkers() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <marker
          id="arrow-depends"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path className="arrow-depends" d="M 0 1 L 9 5 L 0 9 z" />
        </marker>
        <marker
          id="arrow-dataflow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path className="arrow-dataflow" d="M 0 1 L 9 5 L 0 9 z" />
        </marker>
      </defs>
    </svg>
  );
}

/** last path segment, which is what a human calls the project */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * Current project plus a menu of recents and a free-text path. Switching is a
 * bridge-side retarget, so the answer arrives as a fresh `hello` — which is
 * also what closes this menu.
 */
function ProjectSelector() {
  const session = useApp((state) => state.session);
  const recents = useApp((state) => state.recentProjects);
  const errors = useApp((state) => state.errors);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const menuRef = useDismissable(open, setOpen);
  const cwd = session?.cwd ?? null;

  // a successful switch answers with a hello carrying the new cwd
  useEffect(() => {
    setOpen(false);
    setPath("");
  }, [cwd]);

  const switchTo = (target: string): void => {
    const trimmed = target.trim();
    if (trimmed.length === 0) return;
    send({ type: "switch_project", path: trimmed });
  };

  const latestError = errors.length === 0 ? null : errors[errors.length - 1];

  return (
    <div className="project" ref={menuRef}>
      <button
        type="button"
        className="project-current"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={cwd ?? "no project attached"}
      >
        <span className="project-name">{cwd === null ? "no project" : basename(cwd)}</span>
        <span className="project-caret">▾</span>
      </button>

      {open ? (
        <div className="project-menu">
          <p className="project-menu-title">recent projects</p>
          {recents.length === 0 ? (
            <p className="tl-empty">The bridge has not reported any recents yet.</p>
          ) : (
            <ul className="project-recents">
              {recents.map((entry) => (
                <li key={entry}>
                  <button
                    type="button"
                    className="project-recent"
                    data-current={entry === cwd}
                    onClick={() => switchTo(entry)}
                    title={entry}
                  >
                    <span className="project-recent-name">{basename(entry)}</span>
                    <span className="project-recent-path mono">{entry}</span>
                    {entry === cwd ? <span className="project-recent-tag">current</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="project-menu-title">open another</p>
          <div className="project-open">
            <input
              className="project-path mono"
              value={path}
              spellCheck={false}
              placeholder="~/code/..."
              aria-label="project path"
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                switchTo(path);
              }}
            />
            <button type="button" className="btn" onClick={() => switchTo(path)} disabled={path.trim().length === 0}>
              Open
            </button>
          </div>

          {latestError === undefined || latestError === null ? null : (
            <p className="project-error">{latestError.message}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A stable empty snapshot. A zustand selector must never mint a fresh array or
 * object: `useSyncExternalStore` compares snapshots by identity, so `?? []`
 * reads as "changed" on every store read and re-renders forever — which
 * unmounted the whole app on any load where `session` was still null, i.e.
 * every real connection before the first hello.
 */
const NO_WORKTREES: WorktreeInfo[] = [];

/**
 * Which variation of the project you are looking at.
 *
 * Each git worktree is a separate copy of the same project with its own canvas,
 * so switching is the ordinary retarget — no new message. The word "worktree"
 * never appears: the register rule applies to what a person steering by voice
 * reads, and "variation" is what this is to them.
 */
function VariationSwitcher() {
  const worktrees = useApp((state) => state.session?.worktrees ?? NO_WORKTREES);
  const [open, setOpen] = useState(false);
  const menuRef = useDismissable(open, setOpen);

  const current = worktrees.find((entry) => entry.current) ?? null;
  // one variation is just "the project"; there is nothing to switch between
  useEffect(() => {
    if (worktrees.length <= 1) setOpen(false);
  }, [worktrees.length]);
  if (worktrees.length <= 1) return null;

  const nameOf = (entry: { branch: string | null; path: string }): string => entry.branch ?? basename(entry.path);
  const label = current === null ? "unknown" : nameOf(current);

  return (
    <div className="project variation" ref={menuRef}>
      <button
        type="button"
        className="project-current"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={`variation: ${label}${current === null ? "" : ` — ${current.path}`}`}
      >
        <span className="variation-kicker">variation</span>
        <span className="project-name">{label}</span>
        <span className="project-caret">▾</span>
      </button>

      {open ? (
        <div className="project-menu">
          <p className="project-menu-title">variations of this project</p>
          <p className="tl-empty">
            Separate copies of the same project, each with its own canvas. Opening one leaves this one untouched.
          </p>
          <ul className="project-recents">
            {worktrees.map((entry) => (
              <li key={entry.path}>
                {entry.current ? (
                  <span className="project-recent" data-current="true" title={entry.path}>
                    <span className="project-recent-name">{nameOf(entry)}</span>
                    <span className="project-recent-path mono">{entry.path}</span>
                    <span className="project-recent-tag">current</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="project-recent"
                    onClick={() => send({ type: "switch_project", path: entry.path })}
                    title={`open variation ${nameOf(entry)} — ${entry.path}`}
                  >
                    <span className="project-recent-name">{nameOf(entry)}</span>
                    <span className="project-recent-path mono">{entry.path}</span>
                    {entry.branch === null ? <span className="variation-detached">no branch</span> : null}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** project › ancestor › focus — the only way back up, besides Backspace */
function Breadcrumb() {
  const doc = useApp((state) => state.doc);
  const focus = useApp((state) => state.focus);
  const activity = useApp((state) => state.activity);
  const setFocus = useApp((state) => state.setFocus);
  // a comparison is flat and has no focus, so a trail would address nothing
  const comparing = useApp((state) => state.delta !== null);

  const trail = useMemo(() => selectLayer({ doc, focus, activity }).trail, [doc, focus, activity]);
  if (comparing || trail.length === 0) return null;

  return (
    <nav className="crumbs" aria-label="breadcrumb">
      <button type="button" className="crumb" onClick={() => setFocus(null)}>
        project
      </button>
      {trail.map((node, index) => (
        <span key={node.id} className="crumb-step">
          <span className="crumb-sep">›</span>
          <button
            type="button"
            className="crumb"
            aria-current={index === trail.length - 1}
            onClick={() => setFocus(node.id)}
          >
            {node.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

/**
 * Canvas or terminal. Two views of the same project, never side by side: the
 * canvas wants the whole stage and a half-width terminal is a worse terminal.
 */
function ViewToggle() {
  const terminalOpen = useApp((state) => state.terminalOpen);
  const toggleTerminal = useApp((state) => state.toggleTerminal);

  return (
    <div className="view-switch" role="group" aria-label="canvas or terminal">
      <button
        type="button"
        className="view-tab"
        aria-pressed={!terminalOpen}
        onClick={() => {
          if (terminalOpen) toggleTerminal();
        }}
      >
        canvas
      </button>
      <button
        type="button"
        className="view-tab"
        aria-pressed={terminalOpen}
        title="the project's shell — Ctrl+`"
        onClick={() => {
          if (!terminalOpen) toggleTerminal();
        }}
      >
        terminal
      </button>
    </div>
  );
}

function Header() {
  const conn = useApp((state) => state.conn);
  const session = useApp((state) => state.session);
  const doc = useApp((state) => state.doc);
  // this line always describes the project as it stands, which needs saying out
  // loud once the canvas is showing something other than that
  const comparing = useApp((state) => state.delta !== null);

  const model = session?.model;
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark">Shape</span>
        <ProjectSelector />
        <VariationSwitcher />
      </div>
      <ViewToggle />
      {conn === "mock" ? (
        // loud on purpose: the sample graph is fiction and has been mistaken for
        // the real project's architecture
        <span className="badge-mock" title="?mock=1 — hardcoded sample graph, no bridge attached">
          <span className="dot" />
          mock data · sample graph, not this project
        </span>
      ) : (
        <span className={`pill conn-${conn}`} title={session?.cwd ?? "no session"}>
          <span className="dot" />
          {CONN_LABEL[conn]}
        </span>
      )}
      {model === undefined || model === null ? null : (
        <span className="pill" title={`${model.provider}/${model.id}`}>
          {model.id}
        </span>
      )}
      <span className="brand-meta">
        {comparing ? "now · " : null}rev {doc.rev} · {doc.nodes.length} bubbles
      </span>
      <Breadcrumb />
    </header>
  );
}

function StageTools() {
  const showReality = useApp((state) => state.showReality);
  const toggleReality = useApp((state) => state.toggleReality);
  // only the packages no bubble claims are ever drawn, so only those count:
  // a badge promising 9 that renders nothing is worse than no badge
  const realityCount = useApp((state) => selectReality(state.doc).nodes.length);
  const hasNodes = useApp((state) => state.doc.nodes.length > 0);
  const errors = useApp((state) => state.errors);
  const dismissError = useApp((state) => state.dismissError);
  const comparing = useApp((state) => state.delta !== null);
  // the canvas legend has nothing to say about a shell
  const terminalOpen = useApp((state) => state.terminalOpen);

  return (
    <div className="stage-tools">
      {terminalOpen ? null : <Compare />}
      {/* the phase colours and the code layer both describe the project as it is
          now; inside a comparison they would be answering a question nobody asked */}
      {hasNodes && !comparing && !terminalOpen ? (
        <>
          <button
            type="button"
            className="toggle"
            aria-pressed={showReality}
            onClick={toggleReality}
            title="show the code-derived reality layer"
            disabled={realityCount === 0}
          >
            <span className="toggle-box" />
            reality {realityCount === 0 ? "—" : realityCount}
          </button>

          <div className="legend">
            {PHASE_LEGEND.map((phase) => (
              <span key={phase} className={`legend-item legend-${phase}`}>
                <i />
                {phase}
              </span>
            ))}
          </div>
        </>
      ) : null}

      {errors.length === 0 ? null : (
        <div className="errors" role="status">
          {errors.map((error) => (
            <div key={error.seq} className="error-card">
              <span>{error.message}</span>
              <button
                type="button"
                className="error-dismiss"
                onClick={() => dismissError(error.seq)}
                aria-label="dismiss"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  const conn = useApp((state) => state.conn);
  const targetHasCode = useApp((state) => state.session?.targetHasCode === true);
  const [focus, setFocus] = useState("");

  const onboard = (): void => {
    const scope = focus.trim();
    send(scope.length === 0 ? { type: "onboard" } : { type: "onboard", focus: scope });
  };

  return (
    <div className="empty">
      <p className="empty-kicker">
        {conn === "live" || conn === "mock" ? "session attached · canvas empty" : "waiting for the bridge"}
      </p>
      <h1 className="empty-title">Say the idea. The canvas draws itself.</h1>
      <p className="empty-body">
        Type or dictate into the bar below and the agent starts a decomposition here — one bubble per promise it can
        state in a sentence. Once bubbles exist, click one and speak to steer just that part; click a relation to change
        how two parts meet. <kbd>Esc</kbd> drops back to the whole project.
      </p>

      {/* second path: the target already has code, so it can be surveyed instead of imagined */}
      {targetHasCode ? (
        <div className="onboard">
          <div className="onboard-or">
            <span />
            or
            <span />
          </div>
          <p className="empty-body">
            There is already code here. Map it first: packages become bubbles from the imports themselves, then the
            agent surveys them into one-sentence promises. Anything it claims that the code contradicts will glow.
          </p>
          <div className="onboard-row">
            <button type="button" className="btn btn-onboard" onClick={onboard}>
              Map this project
            </button>
            <input
              className="onboard-focus"
              value={focus}
              spellCheck={false}
              placeholder="optional focus — e.g. focus on the server, skip vendored code"
              aria-label="optional survey focus"
              onChange={(event) => setFocus(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                onboard();
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * While drilled in, the focus bubble is not one of its own peers. It sits above
 * the layer as a compact card so its promise and status stay readable without
 * competing for space with the children it contains.
 */
function FocusCard() {
  const doc = useApp((state) => state.doc);
  const focus = useApp((state) => state.focus);
  const activity = useApp((state) => state.activity);
  const select = useApp((state) => state.select);
  const setFocus = useApp((state) => state.setFocus);
  // the canvas flattens a comparison, so there is no bubble to sit above it
  const comparing = useApp((state) => state.delta !== null);

  const layer = useMemo(() => selectLayer({ doc, focus, activity }), [doc, focus, activity]);
  const node = layer.focus;
  if (comparing || node === null) return null;

  const parent = node.parentId;
  return (
    <div className="focus-card" data-phase={node.phase}>
      <button
        type="button"
        className="focus-up"
        title={parent === null ? "back to the project layer" : "up one level"}
        onClick={() => setFocus(parent)}
      >
        ‹
      </button>
      <div className="focus-body">
        <div className="focus-head">
          <span className="focus-dot" />
          <button type="button" className="focus-label" onClick={() => select({ kind: "node", id: node.id })}>
            {node.label}
          </button>
          <span className="focus-phase">{node.phase}</span>
          <span className="focus-count">{layer.nodes.length} inside</span>
        </div>
        <p className="focus-promise">{node.summary}</p>
        {node.status === undefined ? null : (
          <p className="focus-now">
            <span className="tl-now-tag">now</span>
            {node.status}
          </p>
        )}
      </div>
    </div>
  );
}

export function App() {
  const hasNodes = useApp((state) => state.doc.nodes.length > 0);
  const comparing = useApp((state) => state.delta !== null);

  useEffect(() => {
    if (isMockMode()) return startMock();
    connectBridge();
    return undefined;
  }, []);

  // Ctrl+` switches views, and Backspace walks up a level — but never while
  // there is text to delete: the steering input is auto-focused, so stealing
  // the key would break dictation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "`" && event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        useApp.getState().toggleTerminal();
        return;
      }
      if (event.key !== "Backspace" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (target.value.length > 0) return;
      }
      const { focus, doc, delta, setFocus } = useApp.getState();
      // Backspace is drill-up: a comparison is flat and has nothing to drill into
      if (focus === null || delta !== null) return;
      event.preventDefault();
      const current = doc.nodes.find((node) => node.id === focus);
      setFocus(current?.parentId ?? null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="shell">
      <EdgeMarkers />
      {/* the focus card is a row, not an overlay: React Flow measures its own
          container, so giving it a smaller box is what keeps fitView honest */}
      <div className="stage">
        <Header />
        <StageTools />
        <FocusCard />
        <div className="canvas-row">
          <ReactFlowProvider>
            <Canvas />
          </ReactFlowProvider>
        </div>
        {/* stays mounted once shown: hiding it must not cost the scrollback */}
        <TerminalPane />
        {hasNodes || comparing ? null : <EmptyState />}
        <SteeringBar />
      </div>
      <SidePanel />
    </div>
  );
}
