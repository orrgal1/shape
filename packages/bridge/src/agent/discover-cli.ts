/**
 * Standalone probe for `discover.ts`: prints every coding-agent session running
 * on this machine as a JSON array.
 *
 *   node packages/bridge/src/agent/discover-cli.ts
 */

import { discoverSessions } from "./discover.ts";

process.stdout.write(`${JSON.stringify(await discoverSessions(), null, 2)}\n`);
