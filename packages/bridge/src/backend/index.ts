/**
 * Backend registry. Adding a harness = one adapter module + one entry here;
 * the bridge itself stays backend-neutral.
 */

import type { BackendSettings, ShapeConfig } from "./config.ts";
import { ClaudeBackend } from "./claude.ts";
import { OmpBackend } from "./omp.ts";
import type { Backend } from "./types.ts";

/** default command per backend id, used when no config file names one */
const DEFAULT_COMMANDS: Record<string, string[]> = { omp: ["omp"], claude: ["claude"] };

const REGISTRY: Record<string, (command: string[], settings: BackendSettings) => Backend> = {
  omp: (command) => new OmpBackend({ command }),
  claude: (command, settings) =>
    new ClaudeBackend({
      command,
      mode: settings.mode,
      args: settings.args,
      permissionMode: settings.permissionMode,
    }),
};

export const KNOWN_BACKENDS: readonly string[] = Object.keys(REGISTRY);

export function createBackend(id: string, config: ShapeConfig): Backend {
  const make = REGISTRY[id];
  if (make === undefined) {
    throw new Error(`unknown backend "${id}" — known ids: ${KNOWN_BACKENDS.join(", ")}`);
  }
  const settings = config.backends[id] ?? {};
  const command = settings.command ?? DEFAULT_COMMANDS[id];
  if (command === undefined || command.length === 0) {
    throw new Error(`backend "${id}" has no command — set backends.${id}.command in .shape/config.json`);
  }
  return make(command, settings);
}

export type { Backend, BackendEvents, BackendState, BackendToolCall, TerminalSource } from "./types.ts";
export { loadShapeConfig } from "./config.ts";
export type { BackendSettings, ShapeConfig } from "./config.ts";
