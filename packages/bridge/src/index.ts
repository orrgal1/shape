/**
 * Shape in local mode: the canvas server and the agent that watches the
 * machine's coding sessions, in one process, joined by the in-memory link.
 * Same frames and the same records as remote mode — only the transport is
 * shorter and the database is the user's own (`~/.shape/shape.db`, or
 * `$SHAPE_HOME`).
 *
 * `--cwd` may be ANY worktree of the repo: the project is the repo, all of its
 * worktrees share one canvas, and each of them shows whatever session is
 * reporting in from it.
 *
 * Run: node src/index.ts [--cwd <dir>] [--port <n>] [--db <file>]
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BRIDGE_PORT, BRIDGE_WS_PATH } from "../../shared/src/index.ts";
import { AgentRuntime } from "./agent/runtime.ts";
import { ShapeServer } from "./server/server.ts";
import { openSqliteStorage } from "./server/sqlite.ts";
import { memoryLinkPair } from "./transport.ts";
import { SocketServer } from "./wsserver.ts";

interface Cli {
  /** `--cwd <dir>`: any worktree of the repo to watch; the project is the repo */
  cwd: string;
  port: number;
  /** `--db <file>`: the database every project's canvas is kept in */
  db: string;
}

function parseArgv(argv: string[]): Cli {
  const cli: Cli = {
    cwd: process.cwd(),
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
  // and this is the machine those repos are on, so a canvas drawn before Shape
  // kept state here is still there to be taken over
  const server = new ShapeServer({ sockets, storage, importLegacy: true });
  const link = memoryLinkPair();
  server.attachAgent(link.server);
  const agent = new AgentRuntime({
    cwd: cli.cwd,
    sockets,
    link: link.agent,
    // a retarget that failed has left this process with nowhere to stand:
    // the browsers have already been told why, so all that is left is to
    // flush and go
    onExit: () =>
      setTimeout(() => {
        storage.close();
        process.exit(1);
      }, 50),
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
      void agent.stop().then(
        () => {
          storage.close();
          process.exit(0);
        },
        () => process.exit(0),
      );
    });
  }

  // The socket listens BEFORE the agent attaches, and that order matters: a
  // session's first event (Claude Code fires SessionStart within a second of
  // the TUI coming up) arrives over the link, and a hook that finds nobody
  // listening exits silently — the agent would never learn the session id. The
  // banner is still printed last, so "canvas at ..." means fully up.
  await sockets.listen();
  await agent.start();
  console.error(`[bridge] canvas at ${sockets.url(BRIDGE_WS_PATH)} (target ${cli.cwd})`);
} catch (err) {
  console.error(`[bridge] startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
