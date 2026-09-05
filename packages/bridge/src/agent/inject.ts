/**
 * INJECTION: telling the sessions that were already running what Shape is.
 *
 * Everything live on the canvas is live because Shape is INSIDE the session —
 * the omp extension dials the link, and from then on the harness reports its
 * own state. A session that started before Shape did cannot load that
 * extension: its process is up, its `--extension` list is fixed, and nothing
 * short of restarting it (which would throw away the user's work) changes
 * that. So the only channel left is the one a human would use — type into the
 * pane — and the only thing worth typing is the project's directive, which
 * tells the agent how to reach Shape and what to do with it.
 *
 * Three rules make that safe to do automatically:
 *
 *   WHO. `mgr board` is the authority on which panes are the manager's
 *   business: the issues in flight, the ones awaiting approval, the panes being
 *   adopted, and the manager itself. Its `unmanaged` list is deliberately NOT
 *   prompted — those are the user's own shells and agents, and Shape typing
 *   into a pane nobody asked it to touch is a bug, not a feature.
 *
 *   ONCE. A pane is briefed at most once per bridge process. The set of pane
 *   ids lives in the fleet, not here, because the scan loop comes back every
 *   few seconds and a directive pasted twice into a working agent is noise it
 *   has to reason about. A pane already ON the link is skipped outright: it has
 *   the extension, so it knows more about Shape than the directive says.
 *
 *   THE MANAGER IS SPECIAL. A manager that is not shape-aware is also the one
 *   session whose `mgr config` decides whether the builders it launches LATER
 *   come up on the canvas. So it gets a second sentence saying its future
 *   builders are already covered — and, because that sentence must be true
 *   when it is read, the config is written BEFORE the prompt is sent.
 *
 * Nothing in here throws. One pane that will not take the directive (its
 * session ended between `mgr board` and the prompt, its agent is mid-tool and
 * refusing input) is one line on stderr and the next pane; a `mgr board` that
 * failed is one line and this project skipped until the next scan. The canvas
 * is worth more than the briefing.
 */

import { readFile } from "node:fs/promises";
import { MGR, type ManagerEnvironment, configureManager, errText, mgrEnv, parseJson, run } from "./manager.ts";

/**
 * The first thing every briefed pane reads. It says two things the agent needs
 * before it reads a word of the directive: this is not the user talking, and
 * it is not a new task — whatever it was doing is still what it should do.
 */
export const INJECT_PREFIX =
  "Shape is attached to this project. Read and follow the directive below; then continue your current work.";

/**
 * The manager's extra sentence. Without it, a manager reading a directive
 * about Shape's integration would reasonably start wiring its builders up by
 * hand; the bridge has just done that in `mgr config`, so the honest thing is
 * to say so.
 */
export const INJECT_MANAGER_LINE =
  "Future builders you launch are shape-aware automatically via mgr config; you need do nothing for them.";

/**
 * The two herdr calls injection needs. Narrow on purpose: `HerdrLauncher`
 * satisfies it structurally, and a test's fake is a pair of async functions
 * rather than a mock of a socket client.
 */
export interface InjectLauncher {
  workspaceOf(project: { path: string; label: string }): Promise<string | null>;
  prompt(paneId: string, text: string): Promise<void>;
}

/**
 * One pane the board named, reduced to what deciding and prompting need. The
 * cwd is what tells us whether the session is already on the link; `null` (a
 * row whose worktree herdr or the skill will not name) therefore cannot be
 * linked, and the pane is briefed.
 */
interface Pane {
  paneId: string;
  cwd: string | null;
  role: "manager" | "builder";
}

/** a nested object off `mgr board`, or an empty one to read misses from */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * One board row as a pane worth considering, or null when it names none. A
 * row without a pane id is an issue the manager has not started yet (or has
 * already finished): real work on the board, but nothing to type into.
 */
function pane(row: Record<string, unknown>, cwdKey: string, role: "manager" | "builder"): Pane | null {
  const paneId = row.pane_id;
  if (typeof paneId !== "string" || paneId.length === 0) return null;
  const cwd = row[cwdKey];
  return { paneId, cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : null, role };
}

/**
 * Every pane on this board that is the manager's business, manager first.
 *
 * The three lists carry the same identity under two different names: an issue
 * row calls its directory `worktree` (the tree the builder was launched in),
 * while the manager and an adoption report a plain `cwd`. `ready`, `blocked`,
 * `orphans` and `quota` are state about issues, not sessions, and `unmanaged`
 * is explicitly not ours.
 */
function panesOf(board: Record<string, unknown>): Pane[] {
  const found: Pane[] = [];
  const manager = pane(asRecord(board.manager), "cwd", "manager");
  if (manager !== null) found.push(manager);
  for (const key of ["in_flight", "awaiting_approval"] as const) {
    for (const raw of Array.isArray(board[key]) ? (board[key] as unknown[]) : []) {
      const builder = pane(asRecord(raw), "worktree", "builder");
      if (builder !== null) found.push(builder);
    }
  }
  for (const raw of Array.isArray(board.adopting) ? (board.adopting as unknown[]) : []) {
    const builder = pane(asRecord(raw), "cwd", "builder");
    if (builder !== null) found.push(builder);
  }
  return found;
}

/**
 * The panes this pass should actually type into, in the order it should do it.
 *
 * A pane id can appear twice on one board (an issue being adopted, a manager
 * that also holds an issue) and the first sighting wins — which is why the
 * manager is collected first, since its role carries the extra sentence and
 * the config write. Builders are sorted by pane id so that two passes over the
 * same board brief them in the same order, and a log of a session that was
 * briefed halfway through reads the same every time.
 */
function pending(panes: readonly Pane[], env: ManagerEnvironment, briefed: ReadonlySet<string>): Pane[] {
  const seen = new Set<string>();
  const managers: Pane[] = [];
  const builders: Pane[] = [];
  for (const candidate of panes) {
    if (seen.has(candidate.paneId)) continue;
    seen.add(candidate.paneId);
    if (briefed.has(candidate.paneId)) continue;
    // on the link already: the extension is loaded, and a directive telling it
    // to connect is at best a no-op and at worst a distraction
    if (candidate.cwd !== null && env.isLinked(candidate.cwd)) continue;
    (candidate.role === "manager" ? managers : builders).push(candidate);
  }
  builders.sort((a, b) => a.paneId.localeCompare(b.paneId));
  return [...managers, ...builders];
}

/**
 * One injection pass over one project. Never throws.
 *
 * `briefed` is the PROCESS-WIDE set of pane ids already prompted, and it is
 * mutated: every pane this pass reaches is added, so the next scan leaves it
 * alone. The return value is the pane ids briefed by THIS pass — what the
 * caller reports on the link — and is empty for every ordinary reason to have
 * briefed nobody: no directive written yet, no herdr workspace for this
 * project, a `mgr board` that failed, or a board whose panes are all on the
 * link already.
 *
 * Panes are prompted one at a time. herdr serializes PTY input anyway, and
 * doing it in order keeps the stderr trail readable when one of them refuses.
 */
export async function injectProject(
  project: { path: string; label: string },
  launcher: InjectLauncher,
  env: ManagerEnvironment,
  briefed: Set<string>,
): Promise<string[]> {
  // gives back the reservations of the panes not yet briefed; a no-op until
  // the pass has selected its targets
  let release = (): void => {};
  try {
    // the directive is the whole payload; before the runtime has written it
    // there is nothing to say that the session could act on
    if (env.directivePath === null) {
      console.error(`[bridge] inject: ${project.label}: no directive to send`);
      return [];
    }
    const workspaceId = await launcher.workspaceOf(project);
    // a project whose sessions are not in the user's herdr has no panes to
    // type into; that is the ordinary case for a repo they only opened here
    if (workspaceId === null) return [];

    const mgr = env.mgr ?? MGR;
    const listed = await run(mgr, ["board"], project.path, mgrEnv(workspaceId));
    const board = listed.ok ? parseJson(listed.stdout) : null;
    if (board === null) {
      console.error(
        `[bridge] inject: ${project.label}: mgr board failed (${listed.ok ? "unreadable output" : listed.stderr}) — retrying next scan`,
      );
      return [];
    }

    const targets = pending(panesOf(board), env, briefed);
    if (targets.length === 0) return [];
    // RESERVED before the first await below. Two repos in one herdr workspace
    // put the same pane on both boards, and the fleet runs their passes at
    // once: a pane entered here only after its prompt would be typed into
    // twice. A reservation a prompt then fails is given back, so the next
    // scan still retries it.
    for (const target of targets) briefed.add(target.paneId);
    const sent: string[] = [];
    release = () => {
      for (const target of targets) if (!sent.includes(target.paneId)) briefed.delete(target.paneId);
    };

    let directive: string;
    try {
      directive = await readFile(env.directivePath, "utf8");
    } catch (err) {
      release();
      console.error(`[bridge] inject: ${project.label}: directive unreadable (${errText(err)})`);
      return [];
    }

    for (const target of targets) {
      let text = `${INJECT_PREFIX}\n\n${directive}`;
      if (target.role === "manager") {
        // written first so the sentence below is already true when it is read
        await configureManager(project, workspaceId, env, mgr);
        text = `${INJECT_PREFIX}\n${INJECT_MANAGER_LINE}\n\n${directive}`;
      }
      try {
        await launcher.prompt(target.paneId, text);
      } catch (err) {
        // a pane that ended, or an agent that will not take input right now;
        // the next scan finds it again because its reservation is given back
        briefed.delete(target.paneId);
        console.error(`[bridge] inject: ${project.label}: pane ${target.paneId} refused the directive (${errText(err)})`);
        continue;
      }
      sent.push(target.paneId);
      console.error(`[bridge] inject: ${project.label}: briefed pane ${target.paneId} (${target.role})`);
    }
    return sent;
  } catch (err) {
    // a herdr call that dropped mid-pass: one line, the reservations given
    // back, and the next scan tries again
    release();
    console.error(`[bridge] inject: ${project.label}: nothing briefed (${errText(err)})`);
    return [];
  }
}
