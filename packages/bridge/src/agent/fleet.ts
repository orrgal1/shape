/**
 * The agent side of one machine: the loopback link, what is installed here,
 * and one `AgentRuntime` per ACTIVE project.
 *
 * A project is never opened by hand. It enters the registry because a session
 * reported in — a herdr agent running in a repo, a caller greeting on the
 * loopback link, or the `--cwd` this process was started with — and the
 * registry's `status` decides whether it gets a runtime. Everything here is
 * therefore observation: a scan of what is live, handed to the registry, which
 * answers by telling the fleet which projects are active.
 *
 * ONE LINK FOR THE WHOLE PROCESS. A caller names only the directory it runs in,
 * so which project it belongs to is a question no single runtime can answer:
 * the fleet asks each of them in turn (`routeLink`) and, when none claims it,
 * reports the directory to the registry so the project can come into being.
 * The caller is refused meanwhile and hung up on once its project exists, so
 * its own reconnect delivers it to the runtime that now holds it.
 *
 * THE SCAN COSTS A `ps` AND A `git worktree list` PER REPO, so it runs only
 * while somebody is watching: `browsers(n)` starts it and `browsers(0)` stops
 * it. The one exception is the seed scan at `start()`, which is how the
 * machine's projects get into the registry before the first browser connects.
 *
 * A SCAN IS THEREFORE FOUR THINGS: what is live on the machine, grouped into
 * repos; the handoff to the registry; a runtime for every project the registry
 * calls active; and one injection pass per project the scan saw a session in,
 * which briefs that project's sessions with the Shape directive (§Injection).
 * The injection pass is last because it wants the runtimes the handoff opened —
 * which is why the seed scan briefs nobody: it runs before any of them exists.
 */

import { basename } from "node:path";
import type { WorktreeInfo } from "../../../shared/src/index.ts";
import type { ActiveProject, SeenRepo } from "../server/server.ts";
import type { AgentEnd } from "../transport.ts";
import type { SocketServer } from "../wsserver.ts";
import { detectTools, type DetectedTools } from "./detect.ts";
import type { LinkTarget } from "./external.ts";
import type { HerdrLauncher } from "./launcher/herdr.ts";
import { chooseLauncher } from "./launcher/index.ts";
import { mountLoopbackLink, type LoopbackLink } from "./link.ts";
import { AgentRuntime } from "./runtime.ts";
import { canonicalDir, listWorktrees, projectKey, repoIdentity, worktreeContaining } from "./worktrees.ts";

/**
 * How often the machine is re-scanned while a browser is connected. Long
 * enough that a `ps` and one `git worktree list` per repo are nothing, short
 * enough that a session started in another terminal shows up while the user is
 * still looking at the canvas.
 */
const SCAN_INTERVAL_MS = 30_000;
/** how many refused caller directories are remembered before the stale ones are dropped */
const MAX_REPORTED = 256;
const EMPTY: ReadonlySet<string> = new Set();

/** Failures arrive as Errors whose message is already user-facing. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What the fleet needs from the project registry. In local mode it is the
 * `ShapeServer` in this process; a remote agent has none, and then the seeds
 * are the whole fleet.
 */
export interface FleetRegistry {
  activeProjects(): ActiveProject[];
  /**
   * What was seen. `complete` means this was a whole-machine scan, so a
   * project it does not mention has nothing live in it; a single caller
   * reporting in says nothing about the others.
   */
  discovered(repos: SeenRepo[], complete: boolean): Promise<void>;
}

export interface AgentFleetOptions {
  sockets: SocketServer;
  /** repos treated as seen at startup (`--cwd`); may be non-git */
  seeds: string[];
  /** null ⇒ no discovery, no scan: the seeds are the whole fleet (remote agent process) */
  registry: FleetRegistry | null;
  /** a fresh agent link for one runtime; the server end is the caller's business */
  link: () => AgentEnd;
}

export class AgentFleet {
  readonly #sockets: SocketServer;
  readonly #seeds: readonly string[];
  readonly #registry: FleetRegistry | null;
  readonly #newLink: () => AgentEnd;

  /** one PATH, one machine: detected once and handed to every runtime */
  #tools: DetectedTools = { launchers: [], harnesses: [] };
  #launcher: HerdrLauncher | null = null;
  #loopback: LoopbackLink | null = null;

  /** the live runtimes, keyed by their repo's main worktree */
  readonly #runtimes = new Map<string, AgentRuntime>();
  /**
   * Runtimes still coming up, keyed the same way. Two activations of one
   * project (a scan and a status flip in the same tick) must produce one
   * runtime, and `start()` is far too long to hold the map's word for it.
   */
  readonly #starting = new Map<string, Promise<void>>();
  /**
   * Link caller cwds reported to the registry and when. A caller the registry
   * has already heard about and still not placed (its project is inactive, or
   * outside git) retries on its own backoff, and every hook it fires names the
   * same directory: one report per scan interval is all the registry needs.
   */
  readonly #reported = new Map<string, number>();
  /**
   * The herdr panes this PROCESS has briefed with a project's directive
   * (§Injection). Once per pane per process is the contract, so the set
   * outlives any one runtime: a project marked inactive and then active again
   * gets a fresh runtime, and it must not brief the panes the last one did.
   */
  readonly #briefed = new Set<string>();

  #timer: NodeJS.Timeout | null = null;
  /** a scan in flight; a tick that lands on one is dropped rather than queued */
  #scanning: Promise<void> | null = null;
  /** the seeds join the FIRST scan only: afterwards they are ordinary registry rows */
  #seeded = false;
  #stopped = false;

  constructor(opts: AgentFleetOptions) {
    this.#sockets = opts.sockets;
    this.#seeds = opts.seeds;
    this.#registry = opts.registry;
    this.#newLink = opts.link;
  }

  /**
   * Bring the machine up: what is installed, the user's terminal multiplexer,
   * the loopback link, then one scan so the registry knows what is here — and
   * a runtime for every project it calls active.
   *
   * The link is mounted BEFORE the scan so a session that greets (or a hook
   * that fires) during startup finds somebody listening; it is refused until
   * its project exists, and hung up on the moment it does.
   */
  async start(): Promise<void> {
    this.#tools = await detectTools();
    this.#launcher = await chooseLauncher(this.#tools);
    console.error(
      `[bridge] terminal: ${this.#launcher === null ? "none" : "herdr"}; harnesses here: ${this.#tools.harnesses.map((tool) => tool.id).join(", ") || "none"}`,
    );
    this.#loopback = mountLoopbackLink(this.#sockets, { route: (cwd) => this.#route(cwd) });
    await this.#scan();
    const registry = this.#registry;
    // without a registry nothing else will ever name a project: the seeds are it
    const wanted = registry === null ? [...this.#seeds] : registry.activeProjects().map((project) => project.cwd);
    await Promise.all(wanted.map((cwd) => this.#ensure(cwd)));
  }

  /**
   * A project just became active — a row the registry inserted, or one the user
   * flipped back on. Idempotent: the project may already have its runtime.
   */
  activated(project: ActiveProject): void {
    void this.#ensure(project.cwd);
  }

  /**
   * How many browsers are watching. Nobody watching means nothing to keep
   * fresh, so the scan timer exists only while somebody is.
   */
  browsers(count: number): void {
    if (this.#stopped) return;
    if (count === 0) {
      if (this.#timer === null) return;
      clearInterval(this.#timer);
      this.#timer = null;
      return;
    }
    if (this.#timer !== null) return;
    void this.#scan();
    this.#timer = setInterval(() => void this.#scan(), SCAN_INTERVAL_MS);
    // a scan nobody is waiting for must not hold the process open
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const runtimes = [...this.#runtimes.values()];
    this.#runtimes.clear();
    await Promise.all(runtimes.map((runtime) => runtime.stop()));
    this.#loopback?.close();
    this.#loopback = null;
  }

  // ---------------------------------------------------------------------------
  // runtimes
  // ---------------------------------------------------------------------------

  /**
   * A runtime for the repo `cwd` belongs to, unless it already has one. Keyed
   * by the MAIN worktree, because every worktree of a repo is one project and
   * two of them reporting in must not become two runtimes.
   */
  async #ensure(cwd: string): Promise<void> {
    if (this.#stopped) return;
    let main: string;
    try {
      main = (await repoIdentity(cwd)).main;
    } catch (err) {
      console.error(`[bridge] cannot open ${cwd}: ${errText(err)}`);
      return;
    }
    if (this.#stopped) return;
    // a runtime is in the map from the moment it is constructed, so the
    // in-flight entry is checked FIRST: `has` would say yes to a runtime whose
    // attach is still going, and the caller would carry on as if it were up
    const pending = this.#starting.get(main);
    if (pending !== undefined) {
      await pending;
      return;
    }
    if (this.#runtimes.has(main)) return;
    const starting = this.#startRuntime(main);
    this.#starting.set(main, starting);
    try {
      await starting;
    } finally {
      this.#starting.delete(main);
    }
  }

  /**
   * One project's runtime, registered before it starts: a caller that greets
   * during the attach belongs to it already, and the alternative is refusing a
   * session that is plainly inside the repo.
   */
  async #startRuntime(main: string): Promise<void> {
    const label = basename(main);
    const runtime = new AgentRuntime({
      cwd: main,
      sockets: this.#sockets,
      link: this.#newLink(),
      tools: this.#tools,
      launcher: this.#launcher,
      isLinked: (cwd) => this.#isLinked(cwd),
      briefed: this.#briefed,
      // the server closed this project's link: it was marked inactive, or the
      // attach was refused. Either way this project has no room to talk to
      onExit: (reason) => {
        if (this.#runtimes.get(main) !== runtime) return;
        this.#runtimes.delete(main);
        console.error(`[bridge] project ${label}: runtime gone (${reason})`);
      },
    });
    this.#runtimes.set(main, runtime);
    try {
      await runtime.start();
    } catch (err) {
      this.#runtimes.delete(main);
      console.error(`[bridge] project ${label} could not be watched: ${errText(err)}`);
      return;
    }
    console.error(`[bridge] project ${label} active: watching ${main}`);
    // a caller refused while this project did not exist is exactly the caller
    // this runtime was opened for; hanging up is how it gets to re-greet
    this.#loopback?.kickRefused();
  }

  /** Is a loopback caller greeted from this directory right now (the manager pass asks). */
  #isLinked(cwd: string): boolean {
    const wanted = canonicalDir(cwd);
    return (this.#loopback?.greeted() ?? []).some((entry) => canonicalDir(entry) === wanted);
  }

  // ---------------------------------------------------------------------------
  // link routing
  // ---------------------------------------------------------------------------

  /**
   * Which session a loopback caller belongs to. Every runtime is asked, because
   * only a runtime knows its repo's worktrees; a directory none of them claims
   * is a project that does not exist yet, so it is reported to the registry and
   * the caller is refused until it does.
   */
  #route(cwd: string): LinkTarget | { error: string } {
    for (const runtime of this.#runtimes.values()) {
      const target = runtime.routeLink(cwd);
      if (target !== null) return target;
    }
    void this.#ensureProject(cwd);
    return { error: `no active project contains ${cwd}` };
  }

  /**
   * Report the repo a link caller runs in, so the registry can give it a row
   * and (if it is new) a room. Deduped by the spelling the caller used, for one
   * scan interval: a hook that fires every few seconds must not queue one
   * insert per frame, and a caller in an inactive project must not have its row
   * rewritten on every retry.
   */
  async #ensureProject(cwd: string): Promise<void> {
    const registry = this.#registry;
    // a remote agent watches the repos it was given and discovers nothing
    if (registry === null || this.#stopped) return;
    const last = this.#reported.get(cwd);
    const now = Date.now();
    if (last !== undefined && now - last < SCAN_INTERVAL_MS) return;
    this.#reported.set(cwd, now);
    // the map must not grow with every path a caller invents
    if (this.#reported.size > MAX_REPORTED) {
      for (const [entry, at] of this.#reported) if (now - at >= SCAN_INTERVAL_MS) this.#reported.delete(entry);
    }
    try {
      // a caller outside git is a session, but not a project: the scan judges
      // it the same way, and only a `--cwd` seed makes a non-git directory one
      const repo = await this.#seenRepo(cwd, EMPTY);
      if (repo !== null) await registry.discovered([repo], false);
    } catch (err) {
      console.error(`[bridge] cannot place ${cwd}: ${errText(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // discovery scan
  // ---------------------------------------------------------------------------

  /**
   * Everything running on this machine right now, grouped into repos and handed
   * to the registry: the herdr agents' directories, the link callers' and — on
   * the first pass only — the seeds this process was started with.
   *
   * Every cwd is judged on its own. A directory that was removed under a
   * still-running agent, or a repo git will not talk about, costs that cwd and
   * nothing else: a scan that threw would leave the whole machine unreported.
   */
  #scan(): Promise<void> {
    const running = this.#scanning;
    // a 30 s tick landing on a scan that is still going wants the same answer
    if (running !== null) return running;
    const scan = this.#runScan().finally(() => {
      this.#scanning = null;
    });
    this.#scanning = scan;
    return scan;
  }

  async #runScan(): Promise<void> {
    const registry = this.#registry;
    // a remote agent has no registry to report to, and its seeds are already
    // the whole fleet
    if (registry === null || this.#stopped) return;
    const seeded = new Set(this.#seeded ? [] : this.#seeds);
    this.#seeded = true;

    const cwds = new Set<string>([...seeded, ...(await this.#herdrCwds()), ...(this.#loopback?.greeted() ?? [])]);
    const repos = new Map<string, SeenRepo>();
    for (const cwd of cwds) {
      try {
        const repo = await this.#seenRepo(cwd, seeded);
        if (repo === null) continue;
        const known = repos.get(repo.key);
        if (known === undefined) {
          repos.set(repo.key, repo);
          continue;
        }
        for (const id of repo.live) if (!known.live.includes(id)) known.live.push(id);
      } catch (err) {
        console.error(`[bridge] skipping ${cwd} in this scan: ${errText(err)}`);
      }
    }
    if (this.#stopped) return;
    // a scan sees every session on this machine, so a repo it stays silent
    // about has nothing live in it: the registry zeroes those counts itself
    await registry.discovered([...repos.values()], true);
    if (this.#stopped) return;
    // Brief the sessions of every project this scan saw somebody working in
    // (§Injection). Only those: a project with nobody in it has nobody to
    // brief, and `mgr board` costs a `gh` round trip per project, so a repo
    // that went quiet must not be asked about every 30 s.
    //
    // The seed scan in `start()` runs BEFORE any runtime exists, so it briefs
    // nothing — the runtimes it leads to are started right after it, and the
    // first browser-driven scan is what reaches their panes.
    const passes: Promise<void>[] = [];
    for (const repo of repos.values()) {
      if (repo.live.length === 0) continue;
      // runtimes are keyed by the repo's main worktree, which is `repo.cwd`
      const runtime = this.#runtimes.get(repo.cwd);
      if (runtime !== undefined) passes.push(runtime.inject());
    }
    await Promise.all(passes);
  }

  /**
   * One directory as a repo the registry can store: its identity, its
   * worktrees, and the one worktree this directory proves is live.
   *
   * A directory outside git is skipped unless it was named as a seed — a hook
   * firing from a scratch directory is not a project somebody is working on,
   * while a `--cwd` is exactly that, and the operator said so.
   */
  async #seenRepo(cwd: string, seeded: ReadonlySet<string>): Promise<SeenRepo | null> {
    const identity = await repoIdentity(cwd);
    if (identity.commonDir === null && !seeded.has(cwd)) return null;
    const listed = identity.commonDir === null ? [] : await listWorktrees(identity.main);
    // a non-git target is still one variation, or a session would be running in
    // a worktree the browser has never heard of
    const worktrees: WorktreeInfo[] =
      listed.length > 0 ? listed : [{ id: identity.main, path: identity.main, branch: null, head: null }];
    const live = worktreeContaining(worktrees, canonicalDir(cwd));
    return {
      key: projectKey(identity),
      cwd: identity.main,
      label: basename(identity.main),
      worktrees,
      live: live === null ? [] : [live],
    };
  }

  /** Where the user's herdr says its agents are running; nothing when there is no herdr. */
  async #herdrCwds(): Promise<string[]> {
    const launcher = this.#launcher;
    if (launcher === null) return [];
    try {
      return (await launcher.agents()).flatMap((agent) => (agent.cwd === null ? [] : [agent.cwd]));
    } catch (err) {
      console.error(`[bridge] herdr would not list its agents: ${errText(err)}`);
      return [];
    }
  }
}
