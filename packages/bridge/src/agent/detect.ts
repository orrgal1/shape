/**
 * What is installed where this agent runs: the terminal multiplexer Shape can
 * see the user's sessions in, and the coding harnesses present on this
 * machine.
 *
 * Shape starts none of them. This is a description of the machine, which the
 * canvas shows so a person can tell "no session is reporting in" from "there
 * is nothing here to report in" — and so the manager pass knows whether it
 * has a herdr to open its tab in.
 *
 * Cheap on purpose: PATH is walked in process (no `which` subprocess), and
 * only the tools that were FOUND are asked for a version, each with a 3 s
 * ceiling. Nothing here throws; a tool that cannot be classified is simply not
 * reported.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { HarnessId, ToolInfo } from "../../../shared/src/index.ts";

/** every harness Shape knows how to recognize, in the order it lists them */
const HARNESS_IDS: readonly HarnessId[] = [
  "omp",
  "claude",
  "codex",
  "opencode",
  "gemini",
  "cursor-agent",
  "amp",
  "copilot",
];

/**
 * Plain English, as each tool calls itself. This is what a person reads on the
 * canvas, so it is the product's name and never the executable.
 */
const HARNESS_LABELS: Record<HarnessId, string> = {
  omp: "oh-my-pi",
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  gemini: "Gemini CLI",
  "cursor-agent": "Cursor Agent",
  amp: "Amp",
  copilot: "GitHub Copilot CLI",
};

/** the terminal multiplexers Shape can talk to; only herdr for now */
const LAUNCHER_LABELS: Record<string, string> = { herdr: "herdr" };

const LAUNCHER_IDS: readonly string[] = Object.keys(LAUNCHER_LABELS);

/** a tool that cannot say its version in this long is still a detected tool */
const VERSION_TIMEOUT_MS = 3_000;

/** what `--version` may print before we stop believing it is a version */
const MAX_VERSION_LENGTH = 60;

/**
 * The first executable named `name` on PATH. Absolute names are honoured as
 * they are — an operator who put a path in a config file means that file.
 */
async function onPath(name: string): Promise<string | null> {
  if (name.includes("/")) {
    const path = isAbsolute(name) ? name : null;
    if (path === null) return null;
    return (await isExecutable(path)) ? path : null;
  }
  const raw = process.env.PATH ?? "";
  for (const dir of raw.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `<tool> --version`, time-boxed. The first line is taken and the leading
 * program name dropped ("claude 2.1.258 (Claude Code)" -> "2.1.258 (Claude
 * Code)"), because the label already says what the tool is. A tool that fails,
 * hangs or prints an essay answers `null`.
 */
function versionOf(path: string): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  execFile(path, ["--version"], { timeout: VERSION_TIMEOUT_MS, encoding: "utf8" }, (err, stdout, stderr) => {
    if (err !== null && stdout.length === 0) {
      resolve(null);
      return;
    }
    const line = (stdout.length > 0 ? stdout : stderr).split("\n")[0]?.trim() ?? "";
    if (line.length === 0 || line.length > MAX_VERSION_LENGTH) {
      resolve(null);
      return;
    }
    // "claude 2.1.258 (Claude Code)" and "omp/18.1.2" both start with the
    // program's own name, which the label already says; anything else is kept
    // whole rather than mangled
    const match = /^\S*[\s/](?:version\s+)?v?(\d[^\s]*.*)$/.exec(line);
    resolve(match?.[1]?.trim() ?? line);
  });
  return promise;
}

async function detect(ids: readonly string[], labels: Record<string, string>): Promise<ToolInfo[]> {
  const found = await Promise.all(
    ids.map(async (id) => {
      const path = await onPath(id);
      return path === null ? null : { id, path };
    }),
  );
  const tools = await Promise.all(
    found.map(async (hit) =>
      hit === null ? null : { id: hit.id, label: labels[hit.id] ?? hit.id, path: hit.path, version: await versionOf(hit.path) },
    ),
  );
  return tools.filter((tool): tool is ToolInfo => tool !== null);
}

/**
 * A forced tool list, for tests that must not depend on what is installed on
 * the machine running them: `SHAPE_FORCE_HARNESSES="omp,claude"` is exactly
 * two detected harnesses (so "the only one installed" cannot resolve), and an
 * empty string is none at all. Absent means: really look.
 */
function forced(env: string | undefined, labels: Record<string, string>): ToolInfo[] | null {
  if (env === undefined) return null;
  const ids = env
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.map((id) => ({ id, label: labels[id] ?? id, path: id, version: null }));
}

export interface DetectedTools {
  launchers: ToolInfo[];
  harnesses: ToolInfo[];
}

/** Everything installed here, multiplexer and harnesses, in one pass. */
export async function detectTools(): Promise<DetectedTools> {
  const [launchers, harnesses] = await Promise.all([
    forced(process.env.SHAPE_FORCE_LAUNCHERS, LAUNCHER_LABELS) ?? detect(LAUNCHER_IDS, LAUNCHER_LABELS),
    forced(process.env.SHAPE_FORCE_HARNESSES, HARNESS_LABELS) ?? detect(HARNESS_IDS, HARNESS_LABELS),
  ]);
  return { launchers, harnesses };
}
