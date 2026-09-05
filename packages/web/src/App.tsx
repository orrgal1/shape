import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  layerOf,
  type ManagerHandle,
  type ProjectStatus,
  type ProjectSummary,
  type ProjectTools,
  type WorktreeInfo,
} from "../../shared/src/index.ts";
import { Compare } from "./Compare.tsx";
import { SidePanel } from "./SidePanel.tsx";
import { Canvas } from "./canvas/Canvas.tsx";
import { useDismissable } from "./dismiss.ts";
import {
  focusParentOf,
  isCoveredById,
  isHostsId,
  isProductRoot,
  isRealizesId,
  isServesId,
  isVerifiesId,
  selectLayer,
} from "./layer.ts";
import { isMockMode, isSwitcherVariant, startMock } from "./mock.ts";
import {
  branchOf,
  NO_NOW,
  NO_RUNNING,
  NO_WORKTREES,
  runsIn,
  selectAgent,
  selectCurrentProject,
  selectGhostCount,
  selectNow,
  selectRunningSession,
  selectTarget,
  selectThinking,
  toneOf,
  useApp,
  type ConnStatus,
  type NowLine,
} from "./store.ts";
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
 * The projects a session has reported in from, and which of them are the ones
 * being watched. Nothing here opens, creates or finds a project: a project is
 * in this list because an agent turned up in it, and the only input Shape
 * takes is its status — active means a room is open and its state is
 * streaming, inactive means that room is closed and everything it knows kept.
 */
function ProjectSwitcher() {
  const session = useApp((state) => state.session);
  const projects = useApp((state) => state.projects);
  const projectId = useApp((state) => state.projectId);
  const current = useApp(selectCurrentProject);
  const errors = useApp((state) => state.errors);
  const markProjectStatus = useApp((state) => state.markProjectStatus);
  const [open, setOpen] = useState(isSwitcherVariant);
  // the inactive ones are folded away by default: they are the ones nobody
  // asked to watch, and the fold is what makes reviving one possible at all
  const [showInactive, setShowInactive] = useState(isSwitcherVariant);
  const menuRef = useDismissable(open, setOpen);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = useMemo(() => projects.filter((entry) => entry.status === "active"), [projects]);
  const inactive = useMemo(() => projects.filter((entry) => entry.status === "inactive"), [projects]);
  const cwd = session?.cwd ?? null;

  // A switch is answered with a fresh `hello`, so the project arriving is what
  // closes the menu. Arriving at the FIRST project is not that: nobody asked
  // for it, and closing on it would shut a menu opened before the socket
  // greeted.
  const joined = useRef<string | null>(null);
  useEffect(() => {
    const was = joined.current;
    joined.current = projectId;
    if (was === null || projectId === null || was === projectId) return;
    setOpen(false);
  }, [projectId]);

  const latestError = errors.length === 0 ? null : errors[errors.length - 1];

  const switchTo = (entry: ProjectSummary): void => {
    // the one you are already watching is not a switch: the click is a person
    // finding their place in the list, and the menu has served its purpose
    if (entry.projectId === projectId) {
      setOpen(false);
      return;
    }
    send({ type: "select_project", projectId: entry.projectId });
  };

  // The row moves now, not when the server answers: marking a project is the
  // one thing this list does, and a list that waits a round trip to admit it
  // reads as a click that missed. `ingest` puts it back if the server refuses.
  const mark = (entry: ProjectSummary, status: ProjectStatus): void => {
    send({ type: "set_project_status", projectId: entry.projectId, status });
    markProjectStatus(entry.projectId, status);
  };

  /** how much is alive in a project — the reason to switch to one at all */
  const liveOf = (entry: ProjectSummary): string => {
    if (entry.liveSessions === 0) return "no live sessions";
    return entry.liveSessions === 1 ? "1 live session" : `${entry.liveSessions} live sessions`;
  };

  /**
   * Arrows walk the rows, the way every other menu on this screen is walked;
   * Enter is the focused row's own click. The handler sits on the whole
   * control, so an arrow pressed on the trigger — before anything inside has
   * focus — steps into the list rather than scrolling the canvas.
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = rowRefs.current.filter((node): node is HTMLButtonElement => node !== null);
    if (rows.length === 0) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = at === -1 ? (step === 1 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length;
    rows[next]?.focus();
  };

  return (
    <div className="project" ref={menuRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="project-current"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={cwd ?? "no project attached"}
      >
        <span className="project-name">{current?.label ?? (cwd === null ? "no project" : basename(cwd))}</span>
        <span className="project-caret">▾</span>
      </button>

      {open ? (
        <div className="project-menu">
          <p className="project-menu-title">projects being watched</p>
          {active.length === 0 ? (
            <p className="tl-empty">No active projects — start an agent in a repo and it appears here.</p>
          ) : (
            <ul className="project-recents">
              {active.map((entry, index) => (
                <li key={entry.projectId} className="project-row">
                  <button
                    type="button"
                    className="project-recent"
                    ref={(node) => {
                      rowRefs.current[index] = node;
                    }}
                    data-current={entry.projectId === projectId}
                    onClick={() => switchTo(entry)}
                    title={`${entry.cwd} — ${entry.injected} sessions briefed`}
                  >
                    <span className="dot project-room-dot" data-live={entry.liveSessions > 0} />
                    <span className="project-recent-name">{entry.label}</span>
                    <span className="project-recent-path mono">{entry.cwd}</span>
                    {entry.projectId === projectId ? <span className="project-recent-tag">current</span> : null}
                    <span className="project-meta">
                      <span className="project-live" data-on={entry.liveSessions > 0}>
                        {liveOf(entry)}
                      </span>
                      {entry.manager ? <span className="project-mark">manager</span> : null}
                      {entry.caughtUp ? null : <span className="project-mark project-behind">catching up…</span>}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="project-act"
                    onClick={() => mark(entry, "inactive")}
                    title={`close ${entry.label}'s room and keep everything it knows`}
                  >
                    mark inactive
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            className="project-toggle"
            aria-expanded={showInactive}
            disabled={inactive.length === 0}
            onClick={() => setShowInactive((value) => !value)}
            title={
              inactive.length === 0
                ? "every project this server knows is active"
                : "projects kept but not watched: no room, no streaming, all their data"
            }
          >
            <span className="project-caret">{showInactive ? "▾" : "▸"}</span>
            show inactive ({inactive.length})
          </button>
          {showInactive && inactive.length > 0 ? (
            <ul className="project-recents">
              {inactive.map((entry, index) => (
                <li key={entry.projectId} className="project-row">
                  <span className="project-still" title={`${entry.cwd} — ${entry.injected} sessions briefed`}>
                    <span className="project-recent-name">{entry.label}</span>
                    <span className="project-recent-path mono">{entry.cwd}</span>
                    <span className="project-meta">
                      <span className="project-live" data-on={entry.liveSessions > 0}>
                        {liveOf(entry)}
                      </span>
                      {entry.manager ? <span className="project-mark">manager</span> : null}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="project-act"
                    ref={(node) => {
                      rowRefs.current[active.length + index] = node;
                    }}
                    onClick={() => mark(entry, "active")}
                    title={`open ${entry.label}'s room again and stream its state`}
                  >
                    make active
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {latestError === undefined || latestError === null ? null : (
            <p className="project-error">{latestError.message}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Which variations of the project are on the canvas.
 *
 * Every variation of a repo is on one canvas, merged: this is what narrows it,
 * and the way over to the terminal of whichever session is working in one. The
 * word "worktree" never appears — the register rule applies to everything a
 * reader sees, and a variation is its branch to them.
 */
function VariationFilter() {
  const worktrees = useApp((state) => state.session?.worktrees ?? NO_WORKTREES);
  const running = useApp((state) => state.session?.sessions ?? NO_RUNNING);
  const worktreeIds = useApp((state) => state.worktreeIds);
  const filter = useApp((state) => state.filter);
  const setFilter = useApp((state) => state.setFilter);
  const offline = useApp((state) => state.session !== null && !state.session.agentConnected);
  const setTarget = useApp((state) => state.setTarget);
  const notify = useApp((state) => state.notify);
  const [open, setOpen] = useState(false);
  const menuRef = useDismissable(open, setOpen);

  if (worktrees.length === 0) return null;

  const shown = worktrees.filter((entry) => filter === null || filter.has(entry.id));
  const isRunning = (id: string): boolean => running.some((entry) => entry.worktree === id);
  /** where that variation's session runs, or null when nothing runs there */
  const terminalOf = (id: string): "external" | "none" | null =>
    running.find((entry) => entry.worktree === id)?.backend.capabilities.terminal ?? null;
  /**
   * Going to a variation's terminal makes it the one the header and the
   * revision picker are about: reading one branch's shell while the pills name
   * another is how a reader ends up attributing work to the wrong checkout.
   */
  const goTerminal = (id: string): void => {
    setTarget(id);
    send({ type: "focus_terminal", worktree: id });
    notify("opened in your terminal");
    setOpen(false);
  };
  const nameOf = (entry: WorktreeInfo): string => branchOf(worktrees, entry.id);
  // the pill says what is on the canvas: one variation by name, every variation,
  // or how many of how many
  const only = shown.length === 1 ? shown[0] : undefined;
  const label =
    only !== undefined
      ? branchOf(worktrees, only.id)
      : filter === null
        ? "all"
        : `${shown.length} of ${worktrees.length}`;

  /** a checkbox click narrows to, or widens back over, that one variation */
  const toggle = (id: string): void => {
    const next = new Set(shown.map((entry) => entry.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // nothing on the canvas is not a reading of anything: the last one stays
    setFilter(next.size === 0 ? null : next);
  };

  return (
    <div className="project variation" ref={menuRef}>
      <button
        type="button"
        className="project-current"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={
          filter === null
            ? `every variation is on the canvas: ${worktrees.map(nameOf).join(", ")}`
            : `on the canvas: ${shown.map(nameOf).join(", ")}`
        }
      >
        <span className="variation-kicker">variations</span>
        <span className="project-name">{label}</span>
        <span className="project-caret">▾</span>
      </button>

      {open ? (
        <div className="project-menu">
          <p className="project-menu-title">variations of this project</p>
          <p className="tl-empty">
            Separate copies of the same project, drawn on one canvas. A bubble carries a dot per variation that has
            it, hollow where that variation says something else.
          </p>
          <ul className="project-recents variation-list">
            {worktrees.map((entry) => {
              const on = filter === null || filter.has(entry.id);
              const live = isRunning(entry.id);
              return (
                <li key={entry.id} className="variation-row">
                  <label className="variation-pick" title={entry.path}>
                    <input type="checkbox" checked={on} onChange={() => toggle(entry.id)} />
                    <span
                      className="variation-swatch"
                      style={{ ["--wt" as string]: `var(--wt-${toneOf(worktreeIds, entry.id)})` }}
                    />
                    <span className="project-recent-name">{nameOf(entry)}</span>
                    {entry.branch === null ? <span className="variation-detached">no branch</span> : null}
                    <span className="variation-live" data-on={live}>
                      <span className="dot" />
                      {live ? "working here" : "no session"}
                    </span>
                  </label>
                  {offline || !live || terminalOf(entry.id) !== "external" ? null : (
                    <button
                      type="button"
                      className="variation-act"
                      title={`go to the terminal the session on ${nameOf(entry)} is running in`}
                      onClick={() => goTerminal(entry.id)}
                    >
                      terminal
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {filter === null ? null : (
            <button type="button" className="variation-act variation-all" onClick={() => setFilter(null)}>
              show every variation
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * project › ancestor › focus — the only way back up, besides Backspace. Some
 * trails start somewhere else: the product view's begins with the product
 * itself, whose label is the product's name, and each cross-layer drill's
 * begins in the view it was entered from, with the bubble it is answering for,
 * which is also the way back to it.
 */
function Breadcrumb() {
  const doc = useApp((state) => state.doc);
  const focus = useApp((state) => state.focus);
  const view = useApp((state) => state.view);
  const activity = useApp((state) => state.activeNodes);
  const setFocus = useApp((state) => state.setFocus);
  const setView = useApp((state) => state.setView);
  // a comparison is flat and has no focus, so a trail would address nothing
  const comparing = useApp((state) => state.delta !== null);

  const layer = useMemo(() => selectLayer({ doc, focus, activity, layer: view }), [doc, focus, activity, view]);
  const trail = layer.trail;
  const product = layer.product;
  const infra = layer.infra;
  const correctness = layer.correctness;
  const covered = layer.covered;
  const served = layer.served;
  if (comparing || trail.length === 0) return null;

  return (
    <nav className="crumbs" aria-label="breadcrumb">
      {product !== null ? (
        <button
          type="button"
          className="crumb"
          title="back to the product layer"
          onClick={() => setView("product")}
        >
          {product.label}
        </button>
      ) : infra !== null ? (
        // the crumb after this one already names the infrastructure, so this one
        // names the layer it goes back to rather than saying it twice
        <button
          type="button"
          className="crumb"
          title={`back to ${infra.label} on the infra layer`}
          onClick={() => setView("infra")}
        >
          where it runs
        </button>
      ) : correctness !== null ? (
        <button
          type="button"
          className="crumb"
          title={`back to ${correctness.label} on the correctness layer`}
          onClick={() => setView("correctness")}
        >
          what proves it works
        </button>
      ) : covered !== null ? (
        // read from the build end, the trail goes back to the part, so this
        // crumb names the layer that part lives on
        <button
          type="button"
          className="crumb"
          title={`back to ${covered.label} on the build layer`}
          onClick={() => setView("build")}
        >
          project
        </button>
      ) : served !== null ? (
        // like the covered crumb, this one goes back to the part on the build
        // layer rather than repeating its name
        <button
          type="button"
          className="crumb"
          title={`back to ${served.label} on the build layer`}
          onClick={() => setView("build")}
        >
          project
        </button>
      ) : (
        <button type="button" className="crumb" onClick={() => setFocus(null)}>
          {view === "product"
            ? "product"
            : view === "infra"
              ? "where it runs"
              : view === "correctness"
                ? "what proves it works"
                : "project"}
        </button>
      )}
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
 * Which reading of the project is on the canvas: what a person gets out of it,
 * the parts it is made of, where those parts run, or what proves they work.
 * Sits left of the canvas/terminal switch because it changes what is being
 * looked at, not where you look at it. A layer with nothing in it is offered
 * but disabled — the tab is how a reader learns the layer exists, so hiding it
 * teaches them nothing.
 */
function LayerSwitch() {
  const view = useApp((state) => state.view);
  const setView = useApp((state) => state.setView);
  const hasProduct = useApp((state) => state.doc.nodes.some((node) => layerOf(node) === "product"));
  const hasInfra = useApp((state) => state.doc.nodes.some((node) => layerOf(node) === "infra"));
  const hasCorrectness = useApp((state) => state.doc.nodes.some((node) => layerOf(node) === "correctness"));
  // a comparison reads across every layer at once, so none of them is "the" view
  const comparing = useApp((state) => state.delta !== null);
  if (comparing) return null;

  return (
    <div className="layer-switch" role="group" aria-label="product, build, infra or correctness layer">
      <button
        type="button"
        className="layer-tab"
        aria-pressed={view === "product"}
        disabled={!hasProduct}
        title={
          hasProduct
            ? "what people get"
            : "no capability bubbles yet — ask the agent for the product layer"
        }
        onClick={() => setView("product")}
      >
        product
      </button>
      <button
        type="button"
        className="layer-tab"
        aria-pressed={view === "build"}
        title="what it is made of"
        onClick={() => setView("build")}
      >
        build
      </button>
      <button
        type="button"
        className="layer-tab"
        aria-pressed={view === "infra"}
        disabled={!hasInfra}
        title={
          hasInfra ? "where it runs" : "no infrastructure bubbles yet — ask the agent for the infra layer"
        }
        onClick={() => setView("infra")}
      >
        infra
      </button>
      <button
        type="button"
        className="layer-tab"
        aria-pressed={view === "correctness"}
        disabled={!hasCorrectness}
        title={
          hasCorrectness
            ? "what proves it works"
            : "no verification bubbles yet — ask the agent for the correctness layer"
        }
        onClick={() => setView("correctness")}
      >
        correctness
      </button>
    </div>
  );
}

/**
 * Where the harness actually is. Shape does not pretend to be the terminal the
 * session runs in: the session runs in a real one — a herdr tab in the user's
 * own terminal — and this is the way over to it. Nothing changes on this screen
 * when it is clicked, so the click says so out loud.
 *
 * It names the variation the header is about, because that is the session a
 * person means by "the terminal" while looking at this canvas.
 */
function TerminalButton() {
  const target = useApp(selectTarget);
  const running = useApp(selectRunningSession);
  const worktrees = useApp((state) => state.session?.worktrees ?? NO_WORKTREES);
  const notify = useApp((state) => state.notify);
  const terminal = running?.backend.capabilities.terminal ?? null;

  // A session Shape cannot reach the terminal of — no herdr on that machine, or
  // a remote agent — has nothing this button could do, and neither has a
  // variation with no session reporting in at all.
  if (target === null || terminal !== "external") return null;

  const branch = worktrees.length < 2 ? null : branchOf(worktrees, target);

  return (
    <button
      type="button"
      className="go-terminal"
      title="bring the session's own terminal window forward"
      onClick={() => {
        send({ type: "focus_terminal", worktree: target });
        // Focusing a window somewhere else proves nothing here, and a button
        // that looks like it did nothing gets clicked again.
        notify("opened in your terminal");
      }}
    >
      Go to terminal
      {branch === null ? null : <span className="go-terminal-branch">{branch}</span>}
    </button>
  );
}

/**
 * What the header says about this project's manager. "none" is worth a title of
 * its own: a project on a machine with no herdr has nowhere to put a manager,
 * which is a different fact from a herdr workspace that simply has none.
 */
function managerState(
  manager: ManagerHandle | null,
  launcher: ProjectTools["launcher"],
): { label: string; title: string; muted: boolean } {
  if (manager === null) {
    return {
      label: "none",
      // the state word is dimmed when there is nothing behind it, the way the
      // offline pill is: an absent manager is a fact, not a failure
      muted: true,
      title:
        launcher === null
          ? "Managers need herdr, and this machine has none"
          : "No manager tab in this project's herdr workspace",
    };
  }
  // there is one origin: Shape finds a manager in the project's herdr
  // workspace and points its config here, and never opens one
  return {
    label: "attached",
    muted: false,
    title: `Manager ${manager.agentName} in pane ${manager.paneId} (found; Shape extension: ${manager.shapeAware ? "loaded" : "not loaded"})`,
  };
}

function Header() {
  const conn = useApp((state) => state.conn);
  const session = useApp((state) => state.session);
  const doc = useApp((state) => state.doc);
  // the count is about what is being read, not about the file: a build reader
  // counting capabilities they cannot see would be counting someone else's layer
  const shown = useApp((state) => state.doc.nodes.filter((node) => layerOf(node) === state.view).length);
  // this line always describes the project as it stands, which needs saying out
  // loud once the canvas is showing something other than that
  const comparing = useApp((state) => state.delta !== null);

  // The harness pill is about the variation the header is speaking for: it is
  // that variation's own harness, and with none reporting in there is nothing
  // to name.
  const running = useApp(selectRunningSession);
  const target = useApp(selectTarget);
  const branch = session === null || target === null ? null : branchOf(session.worktrees, target);
  const model = running?.session.model ?? null;
  const backend = running?.backend;
  // The manager pill is project-wide, not per variation: one manager per
  // project, and its absence is as worth saying as its presence.
  const launcher = useApp((state) => state.tools?.launcher ?? null);
  const manager = session === null ? null : managerState(session.manager, launcher);
  // the tab says which project this is, or that it is only the sample
  const cwd = session?.cwd;
  useEffect(() => {
    const project = conn === "mock" ? "sample" : cwd === undefined ? null : (cwd.split("/").filter(Boolean).pop() ?? null);
    document.title = project === null ? "Shape" : `${project} · Shape`;
  }, [conn, cwd]);
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark">Shape</span>
        <ProjectSwitcher />
        <VariationFilter />
      </div>
      <LayerSwitch />
      <TerminalButton />
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
      {backend === undefined ? null : (
        <span
          className="pill pill-harness"
          title={`Shape is watching ${backend.label} (${backend.id})${branch === null ? "" : ` on ${branch}`} — events: ${backend.capabilities.events}, terminal: ${backend.capabilities.terminal}${model ? ` — model ${model.provider}/${model.id}` : ""}`}
        >
          <span className="pill-key">harness</span>
          <span className="pill-harness-name">{backend.label}</span>
          {model === null ? null : <span className="pill-harness-model">· {model.id}</span>}
        </span>
      )}
      {manager === null ? null : (
        <span className="pill pill-manager" title={manager.title}>
          <span className="pill-key">manager</span>
          <span className={`pill-manager-state${manager.muted ? " pill-manager-none" : ""}`}>{manager.label}</span>
        </span>
      )}
      {/* the canvas still reads without an agent, but nothing on it will move
          again — said next to the harness that would have moved it */}
      {session === null || session.agentConnected ? null : (
        <span className="pill pill-offline" title="No agent is attached to this project — the picture is frozen">
          <span className="dot" />
          agent offline
        </span>
      )}
      {/* Second line, always: the layer switch made the first one wide enough to
          run under the legend, and what a person reads while navigating — where
          they are, and how big the layer is — must not be the thing that gets
          overlapped. */}
      <div className="header-line">
        <span className="brand-meta">
          {comparing ? "now · " : null}rev {doc.rev} · {shown} bubbles
        </span>
        <Breadcrumb />
      </div>
    </header>
  );
}

function StageTools() {
  const showReality = useApp((state) => state.showReality);
  const toggleReality = useApp((state) => state.toggleReality);
  // Only the cards actually drawn are counted: a badge promising 9 that renders
  // nothing is worse than no badge. Which cards those are depends on where the
  // reader is standing — unclaimed packages, unclaimed infrastructure, or the
  // classes inside the leaf they drilled into.
  const ghostCount = useApp(selectGhostCount);
  const hasNodes = useApp((state) => state.doc.nodes.length > 0);
  const errors = useApp((state) => state.errors);
  const dismissError = useApp((state) => state.dismissError);
  const notice = useApp((state) => state.notice);
  const comparing = useApp((state) => state.delta !== null);
  // extracted code is evidence about the parts and where they run; the product
  // layer's bubbles point at capabilities, so there is nothing to compare there
  const coded = useApp((state) => state.view !== "product");

  return (
    <div className="stage-tools">
      <Compare />
      {/* the phase colours and the code layer both describe the project as it is
          now; inside a comparison they would be answering a question nobody asked */}
      {hasNodes && !comparing ? (
        <>
          {coded ? (
            <button
              type="button"
              className="toggle"
              aria-pressed={showReality}
              onClick={toggleReality}
              title="show what the code itself shows, beside the bubbles"
              disabled={ghostCount === 0}
            >
              <span className="toggle-box" />
              reality {ghostCount === 0 ? "—" : ghostCount}
            </button>
          ) : null}

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

      {/* the quiet counterpart of an error: something happened, just not here */}
      {notice === null ? null : (
        <div className="notice" role="status" key={notice.seq}>
          {notice.text}
        </div>
      )}

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

/**
 * An empty canvas is three different situations, and only one of them is the
 * blank page the big card was written for.
 *
 * A survey is landing: the room maps a coded checkout by itself the moment a
 * session starts in it, so the card's whole job is to say that and get out of
 * the way — bubbles are on their way in.
 *
 * The code already drew itself: the reality strip is on the canvas, which is
 * the answer to "is anything here", so a full-height splash across it is
 * covering its own evidence. One line, off to the side.
 *
 * Nothing at all: no code, no strip, nothing reporting in — the case where the
 * card IS the screen, and says what will fill it.
 */
function EmptyState() {
  const conn = useApp((state) => state.conn);
  const targetHasCode = useApp((state) => state.session?.targetHasCode === true);
  // nothing is reporting in from this variation yet, which is what the copy
  // promises will change once something does
  const asleep = useApp((state) => !runsIn(state.session, selectTarget(state)));
  // What the code already showed of itself: with no bubbles on the canvas the
  // reality strip IS the canvas, and a full-height splash across the middle of
  // it reads as a screen that never went away.
  const ghostCount = useApp(selectGhostCount);
  // A coded checkout maps itself the moment a session starts in it, so a
  // working harness over an empty canvas is that survey landing — the one thing
  // worth saying while it runs.
  const agent = useApp(selectAgent);
  const mapping = targetHasCode && agent !== "idle";

  if (mapping) {
    return (
      <div className="empty empty-compact">
        <p className="empty-kicker">mapping this project</p>
        <p className="empty-body">Reading the code and drawing it here — bubbles appear as it goes.</p>
      </div>
    );
  }

  if (ghostCount > 0) {
    return (
      <div className="empty empty-compact">
        <p className="empty-kicker">not mapped yet</p>
        <p className="empty-body">
          These are the packages the code declares. A session starting in this checkout maps them into bubbles by
          itself.
        </p>
      </div>
    );
  }

  return (
    <div className="empty">
      <p className="empty-kicker">
        {conn !== "live" && conn !== "mock"
          ? "waiting for the bridge"
          : asleep
            ? "no session here yet"
            : "session attached · canvas empty"}
      </p>
      <h1 className="empty-title">Nothing has drawn itself here yet.</h1>
      <p className="empty-body">
        {asleep ? (
          <>
            Shape draws what the coding agents are doing, and nothing is reporting in from this checkout yet. Start
            a session in it the way you always do — a tab in your own terminal — and everything it does draws itself
            here, one bubble per promise it can state in a sentence.
          </>
        ) : (
          <>
            A session is reporting in and has drawn nothing yet. Bubbles appear as it works, one per promise it can
            state in a sentence. Click one to read what it claims; click a relation to read how two parts meet.{" "}
            <kbd>Esc</kbd> drops back to the whole project.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * While drilled in, the focus bubble is not one of its own peers. It sits above
 * the layer as a compact card so its promise and status stay readable without
 * competing for space with the children it contains.
 *
 * The product root gets the same card read as a title: it is not a bubble one
 * drilled into but the thing being built, so it names the product, states the
 * whole promise, and counts the capabilities under it — with no way up, because
 * there is nothing above the whole product.
 */
function FocusCard() {
  const doc = useApp((state) => state.doc);
  const focus = useApp((state) => state.focus);
  const view = useApp((state) => state.view);
  const activity = useApp((state) => state.activeNodes);
  const select = useApp((state) => state.select);
  const setFocus = useApp((state) => state.setFocus);
  const setView = useApp((state) => state.setView);
  // the canvas flattens a comparison, so there is no bubble to sit above it
  const comparing = useApp((state) => state.delta !== null);
  // drilled in, this card IS the bubble being worked on, so it is where the
  // agent's thinking shows while nothing on the layer below is lit yet
  const thinking = useApp(selectThinking);

  const layer = useMemo(() => selectLayer({ doc, focus, activity, layer: view }), [doc, focus, activity, view]);
  const node = layer.focus;
  if (comparing || node === null) return null;

  // a cross-layer drill was entered from another view, so up is back to the
  // bubble it asks about rather than up a hierarchy this layer does not have
  const product = layer.product;
  const infra = layer.infra;
  const correctness = layer.correctness;
  const covered = layer.covered;
  const served = layer.served;
  const fromProduct = product !== null && isRealizesId(node.id);
  const fromInfra = infra !== null && isHostsId(node.id);
  const fromCorrectness = correctness !== null && isVerifiesId(node.id);
  const fromBuild = covered !== null && isCoveredById(node.id);
  const fromServes = served !== null && isServesId(node.id);
  const parent = node.parentId;
  const isRoot = product === null && isProductRoot(doc, view, node.id);
  // the fold counts as what it holds, so the capabilities are counted in the
  // document rather than on screen
  const capabilities = isRoot ? doc.nodes.filter((other) => other.parentId === node.id).length : 0;
  // a leaf's layer is empty of bubbles: what is inside it is its own code, and
  // saying "0 inside" about a file full of classes would be a lie
  const mechanical = layer.nodes.length === 0 && layer.symbols.length > 0;
  return (
    <div
      className="focus-card"
      data-phase={node.phase}
      data-realizes={fromProduct}
      data-hosts={fromInfra}
      data-verifies={fromCorrectness}
      data-covers={fromBuild}
      data-serves={fromServes}
      data-root={isRoot}
      data-thinking={thinking}
    >
      <button
        type="button"
        className="focus-up"
        title={
          fromProduct
            ? `back to ${product.label} on the product layer`
            : fromInfra
              ? `back to ${infra.label} on the infra layer`
              : fromCorrectness
                ? `back to ${correctness.label} on the correctness layer`
                : fromBuild
                  ? `back to ${covered.label} on the build layer`
                  : fromServes
                    ? `back to ${served.label} on the build layer`
                    : isRoot
                      ? "back to the product bubble"
                      : parent === null
                        ? "back to the project layer"
                        : "up one level"
        }
        onClick={() => {
          if (fromProduct) setView("product");
          else if (fromInfra) setView("infra");
          else if (fromCorrectness) setView("correctness");
          else if (fromBuild) setView("build");
          else if (fromServes) setView("build");
          else setFocus(parent);
        }}
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
          <span className="focus-count">
            {isRoot
              ? `${capabilities} ${capabilities === 1 ? "capability" : "capabilities"}`
              : mechanical
                ? `${layer.symbols.length} in its code`
                : `${layer.nodes.length} inside`}
          </span>
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

/**
 * What the agents are doing this second, in the corner of the canvas. The graph
 * only moves when an agent writes to it, which can be a minute apart; this is
 * the small proof that something is still happening in between. One line per
 * working variation, each named by its branch once more than one is on screen.
 * It keeps the last lines while it fades out, so the pill never blinks to empty
 * mid-fade, and it is aria-hidden because the same lines are already in the
 * transcript.
 *
 * A new line does not replace the old one in place: the line it replaces is
 * kept mounted for one animation, rising out of the pill's clipped top while
 * the new one comes up from below. Both are keyed by the LINE's identity, not
 * by its text, so the remount is what plays each animation and no timer is
 * needed to clean up — and a sentence still being written keeps its key, so its
 * words change in place, which is what makes it read as typing rather than as a
 * new line every few hundred milliseconds.
 */
function NowPill() {
  const now = useApp(selectNow);
  const held = useRef<readonly NowLine[]>(NO_NOW);
  const before = useRef<readonly NowLine[]>(NO_NOW);
  if (now.length > 0 && now !== held.current) {
    before.current = held.current;
    held.current = now;
  }
  const lines = held.current;
  const gone = before.current;
  return (
    <div className="now-pill" data-on={now.length > 0} data-lines={lines.length} aria-hidden="true">
      <span className="now-pill-lines">
        {lines.map((line, index) => {
          const previous = gone[index];
          return (
            <span className="now-pill-slot" key={index}>
              {previous === undefined || previous.key === line.key ? null : (
                <span className="now-pill-text now-pill-gone" key={previous.key}>
                  {previous.text}
                </span>
              )}
              <span className="now-pill-text" key={line.key}>
                {line.text}
              </span>
            </span>
          );
        })}
      </span>
      <span className="now-pill-dots" />
    </div>
  );
}

export function App() {
  const hasNodes = useApp((state) => state.doc.nodes.length > 0);
  const comparing = useApp((state) => state.delta !== null);
  const empty = !hasNodes && !comparing;

  useEffect(() => {
    if (isMockMode()) return startMock();
    connectBridge();
    return undefined;
  }, []);

  // Backspace walks up a level — but never while there is text to delete: the
  // project path box and the revision pickers are real inputs, and taking the
  // key from one of them would eat what somebody is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Backspace" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (target.value.length > 0) return;
      }
      const { focus, doc, delta, view, setFocus, setView } = useApp.getState();
      // Backspace is drill-up: a comparison is flat and has nothing to drill
      // into, and the root layer of any view has nothing above it.
      if (focus === null || delta !== null) return;
      event.preventDefault();
      // Out of a cross-layer drill is out of the layer entirely: it was entered
      // from another view, and that is where the bubble it answers for lives.
      if (isRealizesId(focus)) {
        setView(view === "build" ? "product" : "build");
        return;
      }
      if (isHostsId(focus)) {
        setView(view === "build" ? "infra" : "build");
        return;
      }
      if (isVerifiesId(focus)) {
        setView(view === "build" ? "correctness" : "build");
        return;
      }
      if (isCoveredById(focus)) {
        setView(view === "correctness" ? "build" : "correctness");
        return;
      }
      if (isServesId(focus)) {
        setView(view === "product" ? "build" : "product");
        return;
      }
      // one level up is the parent bubble, or the fold this fold nests in
      setFocus(focusParentOf(doc, focus));
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
          <NowPill />
        </div>
        {empty ? <EmptyState /> : null}
      </div>
      <SidePanel />
    </div>
  );
}
