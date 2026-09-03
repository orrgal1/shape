/**
 * Who is on the other end of an upgrade, and which tenant they speak for.
 *
 * Authentication happens once, at the WebSocket upgrade: a socket that exists
 * already has a tenant, so no frame ever carries a token and no handler ever
 * has to wonder. A server started without `--token-file` is unauthenticated —
 * every connection is the `local` tenant — and then it may only bind loopback,
 * because "no auth" on a routable address is an open shell.
 *
 * The table is loaded once at startup and never reloaded: a token change is an
 * operator restarting the server, which is also the only moment a malformed
 * file may take the process down.
 */

import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";

/** the tenant of every connection on an unauthenticated server */
export const LOCAL_TENANT = "local";

/** token → tenant, as loaded from the token file; the only auth question asked at runtime */
export interface TokenTable {
  /** null ⇒ unknown token, which is a 401 at the upgrade */
  tenantOf(token: string): string | null;
}

/** tenant ids name directories under the data dir, so they stay boring on purpose */
const TENANT_RE = /^[a-z0-9][a-z0-9-]*$/;

/** short tokens are guessable; the file is generated, so this costs an operator nothing */
const MIN_TOKEN_LENGTH = 16;

const LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  localhost: true,
  "::1": true,
};

/** a bind address that only this machine can reach, so authentication is optional on it */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS[host.trim().toLowerCase()] === true;
}

/**
 * The reason half of `token file <path>: <reason>`; null ⇒ the entry is good.
 * Entries are reported by index because the file has no other handle on them —
 * and never by token value, which must not reach a log.
 */
function entryProblem(value: unknown, tenants: ReadonlyMap<string, string>): string | null {
  if (value === null || typeof value !== "object") return "not an object";
  // an object from JSON.parse, checked immediately above
  const entry = value as Record<string, unknown>;
  if (typeof entry.token !== "string" || entry.token.length < MIN_TOKEN_LENGTH) {
    return `token must be a string of at least ${MIN_TOKEN_LENGTH} characters`;
  }
  if (typeof entry.tenant !== "string" || !TENANT_RE.test(entry.tenant)) {
    return `tenant must match ${TENANT_RE.source}`;
  }
  if (tenants.has(entry.token)) return "duplicate token";
  return null;
}

/**
 * Read and validate in one pass, filling `tenants` as it goes and returning why
 * it stopped (null = the whole file is good). Reason instead of throw so the
 * `token file <path>: <reason>` sentence exists in exactly one place.
 */
async function tokenFileProblem(path: string, tenants: Map<string, string>): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    return `cannot be read: ${err instanceof Error ? err.message : String(err)}`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "not valid JSON";
  }
  if (!Array.isArray(parsed)) return "expected a JSON array of { token, tenant }";
  if (parsed.length === 0) return "no tokens";

  for (const [index, raw] of (parsed as unknown[]).entries()) {
    const problem = entryProblem(raw, tenants);
    if (problem !== null) return `entry ${index}: ${problem}`;
    // validated by entryProblem
    const entry = raw as { token: string; tenant: string };
    tenants.set(entry.token, entry.tenant);
  }
  return null;
}

/**
 * `[{ "token": "…", "tenant": "…" }, …]`. Every failure is a startup failure:
 * a server that silently ran with half a token file would refuse the operator's
 * own agents, or worse, admit a tenant twice.
 */
export async function loadTokenFile(path: string): Promise<TokenTable> {
  const tenants = new Map<string, string>();
  const problem = await tokenFileProblem(path, tenants);
  if (problem !== null) throw new Error(`token file ${path}: ${problem}`);
  return { tenantOf: (token) => tenants.get(token) ?? null };
}

/**
 * Where the token travels: agents can set headers and use `Authorization:
 * Bearer …`; browsers cannot, so `/ws` also takes `?token=`. Both paths accept
 * both forms — the header first, because a URL ends up in logs and history.
 */
export function tokenFromRequest(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (header !== undefined) {
    const bearer = /^bearer\s+(\S+)$/i.exec(header.trim())?.[1];
    if (bearer !== undefined) return bearer;
  }
  if (request.url === undefined) return null;
  const token = new URL(request.url, "http://localhost").searchParams.get("token");
  return token === null || token.length === 0 ? null : token;
}
