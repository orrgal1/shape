/**
 * Backend registry: harness id -> adapter.
 *
 * Two harnesses have a real integration (omp through its extension, Claude
 * Code through MCP + hooks); every other detected harness gets the generic
 * adapter, which watches instead of talking. Adding an integration = one
 * adapter module + one entry here.
 */

import type { HarnessId } from "../../../../shared/src/index.ts";
import { isHarnessId } from "../detect.ts";
import { ClaudeBackend } from "./claude.ts";
import type { BackendSettings, ShapeConfig } from "./config.ts";
import { GenericBackend } from "./generic.ts";
import { OmpBackend } from "./omp.ts";
import type { Backend } from "./types.ts";

/** default command per harness: its own name on PATH */
const INTEGRATED: Record<string, (command: string[], settings: BackendSettings) => Backend> = {
  omp: (command) => new OmpBackend({ command }),
  claude: (command, settings) =>
    new ClaudeBackend({ command, args: settings.args, permissionMode: settings.permissionMode }),
};

/**
 * Every harness Shape can be asked to start. The integrated ones first,
 * because that is the order the wire and the picker read best.
 */
export function createBackend(id: string, config: ShapeConfig): Backend {
  if (!isHarnessId(id)) {
    throw new Error(`unknown harness "${id}" — Shape can start omp, claude, codex, opencode, gemini, cursor-agent, amp or copilot`);
  }
  const settings = config.backends[id] ?? {};
  const make = INTEGRATED[id];
  if (make === undefined) return new GenericBackend({ id });
  // argv[0] is the executable: the harness's own name unless a config file (or
  // `--omp`) named something else, which is how a fake harness is driven
  const command = settings.command ?? [id];
  if (command.length === 0) {
    throw new Error(`harness "${id}" has no command — set backends.${id}.command in .shape/config.json`);
  }
  return make(command, settings);
}

/** Harness ids that have an adapter of their own rather than the generic one. */
export const INTEGRATED_HARNESSES: readonly HarnessId[] = Object.keys(INTEGRATED).filter(isHarnessId);

export type { Backend, BackendEvents, BackendStart, BackendToolCall } from "./types.ts";
export { loadShapeConfig, rememberBackend, resolveBackend } from "./config.ts";
export type { BackendSettings, ShapeConfig } from "./config.ts";
