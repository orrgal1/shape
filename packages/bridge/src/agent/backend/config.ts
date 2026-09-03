/**
 * Backend selection config: `~/.shape/config.json` (SHAPE_HOME overrides the
 * home dir, as in recents.ts), then `<target>/.shape/config.json` per project,
 * then CLI flags. Missing files are not an error; malformed ones are — a typo
 * in a config file must not silently fall back to a different backend.
 *
 *   { "backend": "omp", "backends": { "omp": { "command": ["omp"] } } }
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { existsSync } from "node:fs";

export interface BackendSettings {
  /** argv of the harness CLI; argv[0] is the executable. Absent ⇒ the adapter's default. */
  command?: string[];
  /** adapter-specific mode (claude: "headless" | "tui") */
  mode?: string;
  /** extra argv the adapter appends to `command` */
  args?: string[];
  /** harness permission mode, passed through to the adapter */
  permissionMode?: string;
}

export interface ShapeConfig {
  /** id of the backend to drive */
  backend: string;
  backends: Record<string, BackendSettings>;
}

export const DEFAULT_CONFIG: ShapeConfig = { backend: "omp", backends: { omp: { command: ["omp"] } } };

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
      for (const key of ["mode", "permissionMode"] as const) {
        if (!(key in entry)) continue;
        const value = entry[key];
        if (typeof value !== "string" || value.trim().length === 0) {
          throw new Error(`config file ${file}: backends.${id}.${key} must be a non-empty string`);
        }
        settings[key] = value.trim();
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
 * `scripts/fake-omp.mjs` would otherwise miss.
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
  /** CLI `--backend <id>`, or the harness id an `adopt` names; beats both config files */
  backend?: string | undefined;
  /** CLI `--omp "<cmd ...>"`; replaces the omp adapter's command */
  ompCommand?: string[] | undefined;
}

/** Effective config for one target project. Throws on a malformed config file. */
export async function loadShapeConfig(overrides: ConfigOverrides): Promise<ShapeConfig> {
  // SHAPE_HOME overrides the home dir (tests), as in recents.ts
  const userFile = join(process.env.SHAPE_HOME ?? homedir(), ".shape", "config.json");
  const projectFile = join(overrides.cwd, ".shape", "config.json");
  let config = mergeLayer(DEFAULT_CONFIG, await readConfigFile(userFile));
  if (projectFile !== userFile) config = mergeLayer(config, await readConfigFile(projectFile));

  if (overrides.backend !== undefined) config = { ...config, backend: overrides.backend };
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
