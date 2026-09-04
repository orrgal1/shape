/**
 * Which harness a project runs, and how to run it: `~/.shape/config.json`
 * (SHAPE_HOME overrides the home dir, as in recents.ts), then
 * `<target>/.shape/config.json` per project. Missing files are not an error;
 * malformed ones are — a typo in a config file must not silently start a
 * different harness.
 *
 *   { "backend": "omp", "backends": { "omp": { "command": ["omp"] } } }
 *
 * Nothing here is required. A project that never chose falls through to omp,
 * the harness Shape supports for now, rather than coming up with no session
 * at all (see `resolveBackend`).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { HarnessId } from "../../../../shared/src/index.ts";

export interface BackendSettings {
  /** argv of the harness CLI; argv[0] is the executable. Absent ⇒ the adapter's default. */
  command?: string[];
  /** extra argv the adapter appends to `command` */
  args?: string[];
  /** harness permission mode, passed through to the adapter */
  permissionMode?: string;
}

export interface ShapeConfig {
  /**
   * The harness the config files name, project file first. `null` when neither
   * said anything, which is not a failure — it is a question for the user.
   */
  backend: string | null;
  backends: Record<string, BackendSettings>;
}

/** `null` when the file is absent; throws (naming the file) when it is broken. */
async function readConfigFile(file: string): Promise<Partial<ShapeConfig> | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`config file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config file ${file} must contain a JSON object`);
  }
  const layer: Partial<ShapeConfig> = {};
  if ("backend" in parsed) {
    if (typeof parsed.backend !== "string" || parsed.backend.trim().length === 0) {
      throw new Error(`config file ${file}: "backend" must be a non-empty string`);
    }
    layer.backend = parsed.backend.trim();
  }
  if ("backends" in parsed && parsed.backends !== undefined) {
    const raw = parsed.backends;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`config file ${file}: "backends" must be an object keyed by backend id`);
    }
    const backends: Record<string, BackendSettings> = {};
    for (const [id, entry] of Object.entries(raw)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`config file ${file}: backends.${id} must be an object`);
      }
      const settings: BackendSettings = {};
      if ("command" in entry) {
        const command = entry.command;
        if (!Array.isArray(command) || command.length === 0 || command.some((t) => typeof t !== "string")) {
          throw new Error(`config file ${file}: backends.${id}.command must be a non-empty array of strings`);
        }
        settings.command = command as string[];
      }
      if ("args" in entry) {
        const args = entry.args;
        if (!Array.isArray(args) || args.some((t) => typeof t !== "string")) {
          throw new Error(`config file ${file}: backends.${id}.args must be an array of strings`);
        }
        settings.args = args as string[];
      }
      if ("permissionMode" in entry) {
        const value = entry.permissionMode;
        if (typeof value !== "string" || value.trim().length === 0) {
          throw new Error(`config file ${file}: backends.${id}.permissionMode must be a non-empty string`);
        }
        settings.permissionMode = value.trim();
      }
      backends[id] = settings;
    }
    layer.backends = backends;
  }
  return layer;
}

/**
 * Script arguments in a command are resolved against the bridge's own cwd, not
 * the target project's — the child runs with cwd = target dir, so a relative
 * `scripts/fake-omp-tui.mjs` would otherwise miss.
 */
function resolveCommand(command: string[]): string[] {
  return command.map((token, idx) => {
    if (idx === 0 || token.startsWith("-") || isAbsolute(token)) return token;
    const abs = resolve(process.cwd(), token);
    return existsSync(abs) ? abs : token;
  });
}

function mergeLayer(base: ShapeConfig, layer: Partial<ShapeConfig> | null): ShapeConfig {
  if (layer === null) return base;
  const backends = { ...base.backends };
  for (const [id, entry] of Object.entries(layer.backends ?? {})) {
    backends[id] = { ...backends[id], ...entry };
  }
  return { backend: layer.backend ?? base.backend, backends };
}

export interface ConfigOverrides {
  /** target project dir, for `<cwd>/.shape/config.json` */
  cwd: string;
  /** CLI `--omp "<cmd ...>"`; the executable and leading args of the omp adapter */
  ompCommand?: string[] | undefined;
}

/** Effective config for one target project. Throws on a malformed config file. */
export async function loadShapeConfig(overrides: ConfigOverrides): Promise<ShapeConfig> {
  // SHAPE_HOME overrides the home dir (tests), as in recents.ts
  const userFile = join(process.env.SHAPE_HOME ?? homedir(), ".shape", "config.json");
  const projectFile = join(overrides.cwd, ".shape", "config.json");
  let config = mergeLayer({ backend: null, backends: {} }, await readConfigFile(userFile));
  if (projectFile !== userFile) config = mergeLayer(config, await readConfigFile(projectFile));

  if (overrides.ompCommand !== undefined) {
    const omp = { ...config.backends.omp, command: overrides.ompCommand };
    config = { ...config, backends: { ...config.backends, omp } };
  }

  const resolved: Record<string, BackendSettings> = {};
  for (const [id, entry] of Object.entries(config.backends)) {
    resolved[id] = entry.command === undefined ? { ...entry } : { ...entry, command: resolveCommand(entry.command) };
  }
  return { backend: config.backend, backends: resolved };
}

/**
 * Which harness to start in one worktree, in the order the user would expect
 * to be obeyed:
 *
 * 1. `explicit` — what this open ASKED for (the start card, an adopt). The
 *    most recent instruction always wins.
 * 2. the config files, project before home: a project that wrote down its
 *    choice must keep it even on a machine whose flags say otherwise.
 * 3. `cli` — `--backend`, the operator's default for the whole process.
 * 4. the only harness installed. With exactly one there is nothing to ask.
 * 5. omp, the harness Shape supports for now. Nothing chose and the machine
 *    is ambiguous (or bare): a session still starts, because a project with
 *    no session is a project the user cannot say anything to.
 */
export function resolveBackend(opts: {
  explicit?: string | undefined;
  config: ShapeConfig;
  cli?: string | undefined;
  detected: readonly HarnessId[];
}): string {
  if (opts.explicit !== undefined && opts.explicit.length > 0) return opts.explicit;
  if (opts.config.backend !== null) return opts.config.backend;
  if (opts.cli !== undefined && opts.cli.length > 0) return opts.cli;
  return opts.detected.length === 1 ? (opts.detected[0] ?? "omp") : "omp";
}

/**
 * Write the project's choice to `<cwd>/.shape/config.json` — "remember this
 * for this project" on the start card. Merged into whatever is already in the
 * file, key by key, because that file is the user's: a `backends` block, a
 * comment-shaped key, anything they put there survives.
 */
export async function rememberBackend(cwd: string, backend: string): Promise<void> {
  const dir = join(cwd, ".shape");
  const file = join(dir, "config.json");
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // absent or unreadable: the choice is still worth recording, and a broken
    // file has already been reported by `loadShapeConfig`
  }
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...existing, backend }, null, 2)}\n`, "utf8");
}
