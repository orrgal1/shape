/**
 * `shape login <server-url> <token>`: remember a Shape server's token so
 * `shape agent --server <url>` needs neither a flag nor an environment
 * variable. The token is written to `~/.shape/servers.json` (mode 0600,
 * `SHAPE_HOME` honored) under the server's `ws://host:port` origin, so one
 * machine can hold credentials for several servers.
 *
 * Run: node src/login-cli.ts ws://host:port <token>
 */

import { saveServerToken, serverOrigin } from "./servers.ts";

const USAGE = "usage: node src/login-cli.ts <server-url> <token>";

interface Cli {
  origin: string;
  token: string;
}

function parseArgv(argv: string[]): Cli {
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--") continue; // pnpm 11 forwards the separator verbatim
    // a token is opaque but never a flag: a stray `--token` here is a mistake
    if (arg.startsWith("--")) throw new Error(`unknown argument ${arg}\n${USAGE}`);
    positional.push(arg);
  }
  const [rawUrl, rawToken] = positional;
  if (positional.length !== 2 || rawUrl === undefined || rawToken === undefined) throw new Error(USAGE);

  const token = rawToken.trim();
  if (token.length === 0) throw new Error(`the token is empty\n${USAGE}`);
  return { origin: serverOrigin(rawUrl), token };
}

// A bad url or a missing argument is a usage error, not a stack trace.
try {
  const cli = parseArgv(process.argv.slice(2));
  const file = await saveServerToken(cli.origin, cli.token);
  console.error(`[bridge] saved token for ${cli.origin} in ${file}`);
} catch (err) {
  console.error(`[bridge] login failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
