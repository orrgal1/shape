/**
 * The per-project directive: one markdown file on disk that tells an agent
 * running in this project what Shape is and how to draw on it.
 *
 * It exists for the harnesses Shape cannot reach into — a session started by
 * hand, or a builder launched by some other manager — which have no `canvas`
 * tool registered and no way to learn the link URL. A launcher points a
 * builder's brief at this path (`mgr config set brief-extra`), the agent reads
 * it mid-task, and the fallback CLI is one command away.
 *
 * Written by the agent runtime, because the agent is where builders run and
 * the only place the link URL is known. `SHAPE_HOME` overrides the home dir
 * (tests), exactly like `recents.ts`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CANVAS_TOOL_DESCRIPTION } from "../../../shared/src/index.ts";

/**
 * The fallback client, by path rather than by import: an agent that reads the
 * directive runs it as its own process, against a checkout where
 * packages/link is present but not built.
 * `<repo>/packages/bridge/src/agent/directive.ts` -> repo.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const LINK_CLI = join(REPO_ROOT, "packages", "link", "src", "cli.ts");

/** Where this project's directive lives; one file per project key. */
export function directivePath(projectKey: string): string {
  const home = process.env.SHAPE_HOME ?? homedir();
  return join(home, ".shape", "server", "projects", projectKey, "shape-directive.md");
}

/**
 * The directive's text. Read by an agent in the middle of a task, so: short,
 * imperative, no marketing. The tool contract is `CANVAS_TOOL_DESCRIPTION`
 * verbatim — the same text the host tool and the MCP server carry, because a
 * third wording here would be a third contract.
 */
export function renderDirective(opts: { linkUrl: string; cliPath: string; projectCwd: string }): string {
  return `# Shape — draw your work on the canvas

Shape is a live canvas of this project that the user is watching while you work: bubbles are the
capabilities, parts, infrastructure and checks of the thing being built. It is their only view of
your work, and it is keyed to this project, so every worktree of it draws on one shared canvas.

## This project

- canvas link: \`SHAPE_LINK=${opts.linkUrl}\`
- project: \`${opts.projectCwd}\`

## The \`canvas\` tool

${CANVAS_TOOL_DESCRIPTION}

## How to reach it

If you have a \`canvas\` tool, use it. Otherwise, from your worktree, run:

\`\`\`sh
SHAPE_LINK=${opts.linkUrl} node ${opts.cliPath} canvas '{"ops":[...]}'
\`\`\`

The argument is the \`canvas\` tool's own argument object (a bare \`[...]\` ops array also works). Run
it from inside your worktree — the canvas you write to is chosen by the directory you run in, and a
call from outside the project is refused. Check the bridge is reachable with:

\`\`\`sh
SHAPE_LINK=${opts.linkUrl} node ${opts.cliPath} status
\`\`\`

\`canvas\` prints exactly one JSON line, \`{"text":…,"isError":…}\` — the same receipt the tool
returns, so read \`text\` for what applied or what was rejected — and exits 0 when \`isError\` is
false, 1 otherwise.
`;
}

/**
 * Persist the directive, writing only when the text changed: the link URL is
 * fixed for an agent process, so a re-open of the same project must not churn
 * the file a launcher may be reading.
 * Errors are the caller's: the directive is a convenience, never fatal.
 */
export async function writeDirective(path: string, content: string): Promise<void> {
  let current: string | null = null;
  try {
    current = await readFile(path, "utf8");
  } catch {
    current = null;
  }
  if (current === content) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
