/**
 * Shape in local mode: the canvas server and the fleet of agent runtimes that
 * watch this machine's coding sessions, in one process, joined by in-memory
 * links. Same frames and the same records as remote mode — only the transport
 * is shorter and the database is the user's own (`~/.shape/shape.db`, or
 * `$SHAPE_HOME`).
 *
 * Nothing here opens a project. The registry in that database IS the list of
 * projects, and a repo is in it because a session reported in from it: a herdr
 * agent the fleet's scan found, a caller that greeted on the loopback link, or
 * `--cwd` — a seed treated exactly like a repo the scan saw. Every ACTIVE
 * project has a room on the server and a runtime in the fleet; marking one
 * inactive closes both and keeps every record it has.
 *
 * `--cwd` is optional and may be ANY worktree of a repo: the project is the
 * repo, all of its worktrees share one canvas, and each of them shows whatever
 * session is reporting in from it.
 *
 * Run: node src/index.ts [--cwd <dir>] [--port <n>] [--db <file>]
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BRIDGE_PORT, BRIDGE_WS_PATH } from "../../shared/src/index.ts";
import { AgentFleet } from "./agent/fleet.ts";
import { LOCAL_TENANT } from "./server/auth.ts";
import { ShapeServer } from "./server/server.ts";
import { openSqliteStorage } from "./server/sqlite.ts";
import { memoryLinkPair } from "./transport.ts";
import { SocketServer } from "./wsserver.ts";

interface Cli {
  /**
   * `--cwd <dir>`: a repo to treat as seen at startup — any worktree of it, the
   * project is the repo. Null without the flag: the registry and what the scan
   * finds are then the whole fleet, which is the ordinary case.
   */
  cwd: string | null;
  port: number;
  /** `--db <file>`: the database every project's canvas is kept in */
  db: string;
}

function parseArgv(argv: string[]): Cli {
  const cli: Cli = {
    cwd: null,
    port: BRIDGE_PORT,
    db: join(process.env.SHAPE_HOME ?? homedir(), ".shape", "shape.db"),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") continue; // pnpm 11 forwards the separator verbatim
    if (arg === "--cwd" && next !== undefined) {
      cli.cwd = resolve(next);
      i++;
    } else if (arg === "--port" && next !== undefined) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isNaN(parsed)) throw new Error(`--port expects a number, got ${next}`);
      cli.port = parsed;
      i++;
    } else if (arg === "--db" && next !== undefined) {
      cli.db = resolve(next);
      i++;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return cli;
}

// A bad flag is a startup error, not a stack trace: the operator needs to read
// what went wrong.
try {
  const cli = parseArgv(process.argv.slice(2));
  const sockets = new SocketServer({ port: cli.port });
  // one database for every project this user opens, keyed by project AND
  // worktree, so every variation of a repo keeps its own canvas on the one
  // canvas they are merged onto
  const storage = openSqliteStorage(cli.db);
  // The two halves close over each other, and neither does anything until it
  // is started below: the server tells the fleet which projects are active and
  // when a browser is watching, the fleet tells the server which repos it saw
  // a session in. `importLegacy` because these repos are on this machine, so a
  // canvas drawn before Shape kept state here is still there to be taken over.
  const server = new ShapeServer({
    sockets,
    storage,
    importLegacy: true,
    onBrowsers: (count) => fleet.browsers(count),
    onActivated: (project) => fleet.activated(project),
  });
  const fleet = new AgentFleet({
    sockets,
    seeds: cli.cwd === null ? [] : [cli.cwd],
    registry: {
      activeProjects: () => server.activeProjects(),
      discovered: (repos) => server.discovered(LOCAL_TENANT, repos),
    },
    // one link per runtime: the server end is this process's business, so it
    // is attached here and the agent end handed back
    link: () => {
      const pair = memoryLinkPair();
      server.attachAgent(pair.server);
      return pair.agent;
    },
  });

  // Sessions live in the user's own terminal and outlive this process: a
  // bridge stopped by its supervisor (or Ctrl-C) leaves them running and only
  // stops watching. Registered before start() so a stop mid-startup settles
  // too.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void fleet.stop().then(
        () => {
          storage.close();
          process.exit(0);
        },
        () => process.exit(0),
      );
    });
  }

  // The registry is loaded before anything can reach the server: the projects
  // this machine had are the projects it has, and their rooms are open before
  // the first browser or session arrives. The socket then listens BEFORE the
  // fleet starts, and that order matters: a session's first event (Claude Code
  // fires SessionStart within a second of the TUI coming up) arrives over the
  // link, and a hook that finds nobody listening exits silently — the agent
  // would never learn the session id. The banner is printed last, so "canvas
  // at ..." means fully up.
  await server.restore();
  await sockets.listen();
  await fleet.start();
  const seed = cli.cwd === null ? "" : ` (seed ${cli.cwd})`;
  console.error(`[bridge] canvas at ${sockets.url(BRIDGE_WS_PATH)}${seed}`);
} catch (err) {
  console.error(`[bridge] startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
