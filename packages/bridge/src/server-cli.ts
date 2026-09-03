/**
 * The Shape server as its own process: browsers on `/ws`, agents on `/agent`,
 * nothing spawned and no repo touched. Every project comes from an agent that
 * connects in (`src/agent-cli.ts`); local mode (`src/index.ts`) is still the
 * same server with an in-memory link instead of a socket.
 *
 * Graphs live under `--data-dir`, not in the repos: the projects are on other
 * machines. That directory is also what a restart reads its rooms back from.
 *
 * Run: node src/server-cli.ts [--port 4400] [--host 127.0.0.1] [--data-dir <dir>]
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_WS_PATH, BRIDGE_PORT, BRIDGE_WS_PATH } from "../../shared/src/index.ts";
import { ShapeServer } from "./server/server.ts";
import { dataDirStorage } from "./server/storage.ts";
import { SocketServer } from "./wsserver.ts";

interface Cli {
  port: number;
  /**
   * `--host`: a non-loopback bind is accepted while the server is unauthenticated
   * (Phase 1); Phase 3 gates it behind a token.
   */
  host: string;
  /** `--data-dir`: every project's graph, revisions and registry row */
  dataDir: string;
}

function parseArgv(argv: string[]): Cli {
  const cli: Cli = {
    port: BRIDGE_PORT,
    host: "127.0.0.1",
    dataDir: join(process.env.SHAPE_HOME ?? homedir(), ".shape", "server"),
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
  const sockets = new SocketServer({ port: cli.port, host: cli.host });
  await mkdir(cli.dataDir, { recursive: true });
  // mounts both paths and needs no further handle beyond the restore below:
  // agents arrive on their own
  const server = new ShapeServer({ sockets, storage: dataDirStorage(cli.dataDir) });
  // rooms are back — agentless — before the first browser or agent can arrive
  const restored = await server.restore();
  if (restored > 0) console.error(`[bridge] restored ${restored} project(s) from ${cli.dataDir}`);
  await sockets.listen();
  console.error(`[bridge] server at ${sockets.url(BRIDGE_WS_PATH)} (agents at ${AGENT_WS_PATH})`);
} catch (err) {
  console.error(`[bridge] startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
