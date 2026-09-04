/**
 * The Shape server as its own process: browsers on `/ws`, agents on `/agent`,
 * nothing spawned and no repo touched. Every project comes from an agent that
 * connects in (`src/agent-cli.ts`); local mode (`src/index.ts`) is still the
 * same server with an in-memory link instead of a socket.
 *
 * Every project's graph, revisions, registry row and audit line live in
 * `<data-dir>/shape.db`, not in the repos: the projects are on other machines.
 * That database is also what a restart reads its rooms back from.
 *
 * `--token-file` is what makes the server multi-tenant AND what makes it safe
 * to expose: without one it admits everyone as the `local` tenant, so it may
 * only bind loopback.
 *
 * Run: node src/server-cli.ts [--port 4400] [--host 127.0.0.1] [--data-dir <dir>]
 *                             [--token-file <file>]
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_WS_PATH, BRIDGE_PORT, BRIDGE_WS_PATH } from "../../shared/src/index.ts";
import { isLoopbackHost, loadTokenFile } from "./server/auth.ts";
import { importLegacyDataDir } from "./server/legacy.ts";
import { ShapeServer } from "./server/server.ts";
import { openSqliteStorage } from "./server/sqlite.ts";
import { SocketServer } from "./wsserver.ts";

interface Cli {
  port: number;
  /**
   * `--host`: anything but loopback needs `--token-file`; an unauthenticated
   * server on a routable address is an open canvas and an open steer channel.
   */
  host: string;
  /** `--data-dir`: holds `shape.db`, every project's graph, revisions and registry row */
  dataDir: string;
  /** `--token-file`: `[{ token, tenant }, …]`; null ⇒ unauthenticated, one `local` tenant */
  tokenFile: string | null;
}

function parseArgv(argv: string[]): Cli {
  const cli: Cli = {
    port: BRIDGE_PORT,
    host: "127.0.0.1",
    dataDir: join(process.env.SHAPE_HOME ?? homedir(), ".shape", "server"),
    tokenFile: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") continue; // pnpm 11 forwards the separator verbatim
    if (arg === "--port" && next !== undefined) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isNaN(parsed)) throw new Error(`--port expects a number, got ${next}`);
      cli.port = parsed;
      i++;
    } else if (arg === "--host" && next !== undefined) {
      cli.host = next.trim();
      i++;
    } else if (arg === "--data-dir" && next !== undefined) {
      cli.dataDir = resolve(next);
      i++;
    } else if (arg === "--token-file" && next !== undefined) {
      cli.tokenFile = resolve(next);
      i++;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return cli;
}

// A port already in use or a bad argument is a startup error, not a stack
// trace: the operator needs to read what went wrong.
try {
  const cli = parseArgv(process.argv.slice(2));
  // before anything binds or is read: an unauthenticated server on a routable
  // address would hand every graph and every steer channel to the network
  if (!isLoopbackHost(cli.host) && cli.tokenFile === null) {
    throw new Error(`refusing to listen on ${cli.host} without --token-file`);
  }
  // one read at startup; a token change is an operator restarting the server
  const auth = cli.tokenFile === null ? null : await loadTokenFile(cli.tokenFile);
  const sockets = new SocketServer({ port: cli.port, host: cli.host });
  await mkdir(cli.dataDir, { recursive: true });
  const storage = openSqliteStorage(join(cli.dataDir, "shape.db"));
  // a data dir written by a pre-SQLite server is taken over once, before any
  // room can open on top of it
  await importLegacyDataDir(storage, cli.dataDir);
  // mounts both paths and needs no further handle beyond the restore below:
  // agents arrive on their own
  const server = new ShapeServer({ sockets, storage, auth });
  // rooms are back — agentless — before the first browser or agent can arrive
  const restored = await server.restore();
  if (restored > 0) console.error(`[bridge] restored ${restored} project(s) from ${cli.dataDir}`);
  await sockets.listen();
  console.error(`[bridge] server at ${sockets.url(BRIDGE_WS_PATH)} (agents at ${AGENT_WS_PATH})`);
} catch (err) {
  console.error(`[bridge] startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
