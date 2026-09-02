/**
 * Backend registry. Adding a harness = one adapter module + one entry here;
 * the bridge itself stays backend-neutral.
 */

import type { ShapeConfig } from "./config.ts";
import { OmpBackend } from "./omp.ts";
import type { Backend } from "./types.ts";

/** default command per backend id, used when no config file names one */
const DEFAULT_COMMANDS: Record<string, string[]> = { omp: ["omp"] };

const REGISTRY: Record<string, (command: string[]) => Backend> = {
  omp: (command) => new OmpBackend({ command }),
};

export const KNOWN_BACKENDS: readonly string[] = Object.keys(REGISTRY);

export function createBackend(id: string, config: ShapeConfig): Backend {
  const make = REGISTRY[id];
  if (make === undefined) {
    throw new Error(`unknown backend "${id}" — known ids: ${KNOWN_BACKENDS.join(", ")}`);
  }
  const command = config.backends[id]?.command ?? DEFAULT_COMMANDS[id];
  if (command === undefined || command.length === 0) {
    throw new Error(`backend "${id}" has no command — set backends.${id}.command in .shape/config.json`);
  }
  return make(command);
}

export type { Backend, BackendEvents, BackendState, BackendToolCall } from "./types.ts";
export { loadShapeConfig } from "./config.ts";
export type { ShapeConfig } from "./config.ts";
