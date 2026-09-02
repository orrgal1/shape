/**
 * Launch lines for the link, resolved from this file's own location.
 *
 * Adapters write these into harness configuration (`--mcp-config`, a hook
 * entry, `.mcp.json`), which means the paths must be absolute and must not
 * depend on the harness's cwd — and no adapter should hardcode a repo layout
 * that can be moved.
 *
 * `process.execPath` rather than the bare word "node": the harness we are
 * configuring inherits whatever PATH its user has, and the link needs the
 * Node that runs TypeScript sources directly.
 */

import { fileURLToPath } from "node:url";

/** argv for the stdio MCP server exposing the `canvas` tool */
export function linkMcpCommand(): string[] {
  return [process.execPath, fileURLToPath(new URL("./mcp.ts", import.meta.url))];
}

/** argv for the hook that turns one harness hook payload into one agent event */
export function linkHookCommand(): string[] {
  return [process.execPath, fileURLToPath(new URL("./hook.ts", import.meta.url))];
}
