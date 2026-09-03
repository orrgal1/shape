/**
 * Server credentials for the agent side: `~/.shape/servers.json`, one token per
 * server origin, written by `shape login` (src/login-cli.ts) and read by
 * `shape agent` (src/agent-cli.ts) when neither `--token` nor `SHAPE_TOKEN`
 * says otherwise. `SHAPE_HOME` overrides the home dir (tests), as in
 * agent/recents.ts.
 *
 * File shape: `{ "ws://host:port": { "token": "…" } }`. The file is a secret,
 * so it is mode 0600 — nothing in Shape reads it but the operator's own agent.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** the token file is a secret: owner read/write, nothing else */
const SECRET_MODE = 0o600;

const SERVERS_FILE = join(process.env.SHAPE_HOME ?? homedir(), ".shape", "servers.json");

/**
 * The key a token is stored under. `ws://host:port/agent`, `ws://host:port` and
 * a trailing slash all name the same server, so they must all find the same
 * token.
 */
export function serverOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`expected a ws:// url, got ${raw}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`expected a ws:// or wss:// url, got ${raw}`);
  }
  return url.origin;
}

/**
 * Stored entries, dropping anything that is not an origin with a token. A
 * missing or unreadable file is "no credentials", not an error: running
 * without `shape login` is the normal case.
 */
async function readStore(): Promise<Record<string, { token: string }>> {
  let text: string;
  try {
    text = await readFile(SERVERS_FILE, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const store: Record<string, { token: string }> = {};
  for (const [origin, entry] of Object.entries(parsed)) {
    if (typeof entry !== "object" || entry === null || !("token" in entry)) continue;
    const token: unknown = entry.token;
    if (typeof token === "string" && token.length > 0) store[origin] = { token };
  }
  return store;
}

/** The token `shape login` saved for this server, or null. */
export async function tokenForServer(origin: string): Promise<string | null> {
  const store = await readStore();
  return store[origin]?.token ?? null;
}

/** Remember `token` for `origin`, keeping every other server's. Returns the file. */
export async function saveServerToken(origin: string, token: string): Promise<string> {
  const store = await readStore();
  store[origin] = { token };
  await mkdir(dirname(SERVERS_FILE), { recursive: true });
  await writeFile(SERVERS_FILE, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: SECRET_MODE,
  });
  // `mode` above only applies when writeFile creates the file: updating one
  // that already exists must not leave an old, laxer mode in place
  await chmod(SERVERS_FILE, SECRET_MODE);
  return SERVERS_FILE;
}
