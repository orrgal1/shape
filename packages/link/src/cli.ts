#!/usr/bin/env node
/**
 * The link from a command line: one canvas call, or one reachability answer.
 *
 * A session that has no `canvas` tool — a plain agent in a terminal, a script,
 * a builder someone started by hand — still has to be able to draw on the
 * canvas the user is watching. `shape-directive.md` tells such a session to run
 * this file, so this is the lowest-common-denominator channel: no MCP, no
 * extension, no long-lived process, just `node cli.ts canvas '<json>'`.
 *
 *   SHAPE_LINK=ws://127.0.0.1:4400/link node cli.ts canvas '{"ops":[…]}'
 *   node cli.ts status --link ws://127.0.0.1:4400/link
 *
 * Two rules make it safe to run from anywhere:
 *
 * - It identifies itself with `process.cwd()` and nothing else. That is what
 *   the bridge routes on (`agent/runtime.ts` `#routeLink`), so the canvas a
 *   call lands on is the worktree the caller is standing in, and a cwd outside
 *   the project comes back refused rather than drawn somewhere wrong.
 * - It NEVER sends `hello`. A `hello` claims to BE the harness of that
 *   worktree, and the bridge replays that socket's close as the `bye` the
 *   harness never sent (`agent/link.ts`) — a one-shot CLI would therefore end
 *   the real session's adapter state on exit. Like the MCP sidecar, it only
 *   ever asks.
 *
 * The canvas itself lives entirely on the other side: this is a thin client,
 * and every word it prints about a call is the bridge's own receipt.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  CALL_TIMEOUT_MS,
  CanvasCalls,
  canvasCallFrame,
  parseServerFrame,
  socketMessageText,
  UNREACHABLE,
  type CallResult,
  type LinkSocket,
} from "./frames.ts";

/**
 * Node's own WHATWG socket (global since Node 22), declared locally for the
 * same reason the extension declares Bun's: this package's tsconfig has no DOM
 * lib. Using the global rather than `ws` is deliberate — the directive hands
 * this path to agents in other repos, and a client that resolves no packages
 * cannot fail to resolve one.
 */
declare const WebSocket: {
  new (url: string): LinkSocket;
  readonly OPEN: number;
};

const USAGE = `Usage: node cli.ts canvas '<json>' [--link <ws url>] | node cli.ts status [--link <ws url>]

Talks to the Shape bridge over the loopback link and identifies this worktree by the directory it runs in, so run it from inside the worktree whose canvas you mean. The link url comes from SHAPE_LINK or --link and has no default. "canvas" takes one argument, either the canvas tool argument object ({"ops":[...],"note":"...","next":{...}}) or a bare ops array, sends it as a single canvas call, prints the bridge's receipt as one JSON line {"text":...,"isError":...} and exits 0 when the call applied or 1 when it did not. "status" prints one JSON line saying whether the bridge answered, which worktree this directory resolves to and what the bridge says about it, exiting 0 when reachable and 1 when not.`;

/** a caller mistake: nothing was asked of the bridge, so there is no receipt */
function die(message: string): never {
  process.stderr.write(`shape link: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

interface Answer extends CallResult {
  /** whether the socket ever opened — what `status` reports as `reachable` */
  reachable: boolean;
}

/**
 * One socket, one `canvas_call`, one answer. Every way the answer can fail to
 * arrive ends in an `Answer` rather than a hang: the correlator times out, a
 * refused connection closes, and either way the text names the url the caller
 * would otherwise have to guess at.
 */
async function callCanvas(link: string, args: unknown): Promise<Answer> {
  const down = `${UNREACHABLE} at ${link}`;
  const calls = new CanvasCalls(CALL_TIMEOUT_MS);
  const id = calls.nextId(`cli-${process.pid}`);
  let socket: LinkSocket;
  try {
    socket = new WebSocket(link);
  } catch (err) {
    return { text: `${down}: ${err instanceof Error ? err.message : String(err)}`, isError: true, reachable: false };
  }

  let reachable = false;
  // registered before the socket can answer: a result on the same tick is ours
  const answer = calls.open(id);
  socket.addEventListener("open", () => {
    reachable = true;
    socket.send(JSON.stringify(canvasCallFrame(process.cwd(), id, args)));
  });
  socket.addEventListener("message", (event: unknown) => {
    const text = socketMessageText(event);
    if (text === null) return;
    const frame = parseServerFrame(text);
    if (frame !== null) calls.settle(frame);
  });
  // a refused connection fires `error` then `close`; a dropped one only `close`
  socket.addEventListener("error", () => calls.settleAll(down));
  socket.addEventListener("close", () => calls.settleAll(down));

  const result = await answer;
  try {
    socket.close();
  } catch {
    // already gone; the process is about to exit anyway
  }
  return { ...result, reachable };
}

/**
 * Which worktree this directory belongs to, resolved the way the bridge
 * resolves it: the enclosing git worktree, as a realpath (a worktree id is
 * always canonical, and on macOS every `/tmp` path is a symlink). Reported so
 * a session can see whose canvas it is about to draw on before it draws.
 */
function worktreeOf(cwd: string): string | null {
  let top: string;
  try {
    top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // not a git directory at all: there is no worktree to name
    return null;
  }
  if (top === "") return null;
  try {
    return realpathSync(top);
  } catch {
    return top;
  }
}

/**
 * The reachability probe: an empty ops list. `parseCanvasArgs`
 * (`bridge/src/server/store.ts`) refuses it before a single op is applied, so
 * it cannot change a graph, bump a revision or file a snapshot — while still
 * travelling the whole path a real call takes, including the cwd routing in
 * `#routeLink`. What comes back is therefore the honest answer to "would my
 * canvas calls land?": the routing refusal when they would not, and the
 * bad-args receipt when they would.
 */
const PROBE = { ops: [] };

const argv = process.argv.slice(2);
let linkFlag: string | null = null;
const words: string[] = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === undefined) continue;
  if (arg === "--link") {
    const value = argv[i + 1];
    if (value === undefined) die("--link needs a websocket url");
    linkFlag = value;
    i += 1;
    continue;
  }
  if (arg.startsWith("--link=")) {
    linkFlag = arg.slice("--link=".length);
    continue;
  }
  words.push(arg);
}

const command = words[0];
if (command === undefined) die("no subcommand — expected `canvas` or `status`");
if (command !== "canvas" && command !== "status") die(`unknown subcommand "${command}" — expected \`canvas\` or \`status\``);

const link = linkFlag ?? process.env.SHAPE_LINK ?? "";
if (link === "") die("no link url — set SHAPE_LINK or pass --link ws://127.0.0.1:4400/link");

if (command === "status") {
  const probe = await callCanvas(link, PROBE);
  process.stdout.write(
    `${JSON.stringify({
      reachable: probe.reachable,
      link,
      cwd: process.cwd(),
      worktree: worktreeOf(process.cwd()),
      session: probe.text,
    })}\n`,
  );
  process.exit(probe.reachable ? 0 : 1);
}

const raw = words[1];
if (raw === undefined) die("canvas needs one argument: the canvas tool arguments as JSON");
let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  die(`the canvas argument is not JSON: ${err instanceof Error ? err.message : String(err)}`);
}
// a bare ops array is the shorthand every agent reaches for first; the tool's
// own argument object is what the bridge validates, so wrap it here
const args = Array.isArray(parsed) ? { ops: parsed } : parsed;
if (args === null || typeof args !== "object") {
  die("the canvas argument must be the tool argument object or a bare ops array");
}

const result = await callCanvas(link, args);
process.stdout.write(`${JSON.stringify({ text: result.text, isError: result.isError })}\n`);
process.exit(result.isError ? 1 : 0);
