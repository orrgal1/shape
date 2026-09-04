/**
 * Which launcher this agent process uses, decided once at startup.
 *
 * herdr wins when it is installed AND its socket answers, because then the
 * user's own terminal is the session's home and Shape is plainly a layer over
 * it. Otherwise Shape's own pty carries the session and the browser renders
 * it. `SHAPE_LAUNCHER` forces the choice for a test or an operator who knows
 * better; a forced herdr whose socket does not answer still falls back rather
 * than leaving the agent with no way to start anything.
 */

import type { DetectedTools } from "../detect.ts";
import { HerdrLauncher } from "./herdr.ts";
import { PtyLauncher, type PtyLauncherOptions } from "./pty.ts";
import type { Launcher } from "./types.ts";

export async function chooseLauncher(opts: {
  tools: DetectedTools;
  pty: PtyLauncherOptions;
}): Promise<Launcher> {
  const forced = process.env.SHAPE_LAUNCHER?.trim();
  const detected = opts.tools.launchers.some((tool) => tool.id === "herdr");
  const wantHerdr = forced === "herdr" || (forced === undefined && detected);
  if (forced !== undefined && forced !== "herdr" && forced !== "pty") {
    console.error(`[bridge] SHAPE_LAUNCHER must be "herdr" or "pty" (got "${forced}") — using Shape's own terminal`);
  }
  if (wantHerdr) {
    const herdr = await HerdrLauncher.probe();
    if (herdr !== null) return herdr;
  }
  return new PtyLauncher(opts.pty);
}

export { HerdrLauncher, herdrSocketPath } from "./herdr.ts";
export { PtyLauncher } from "./pty.ts";
export type { AgentStatus, Launched, LaunchSpec, Launcher } from "./types.ts";
