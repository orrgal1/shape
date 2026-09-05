/**
 * Whether this agent has a herdr to talk to, decided once at startup.
 *
 * herdr is not how Shape starts sessions — nothing here starts a session — it
 * is how Shape can SEE the user's own terminal: the tab a session runs in can
 * be brought forward, and the project's manager tab can be found or opened.
 * Without it a project still has a canvas; its sessions simply have no
 * terminal Shape can reach. `SHAPE_LAUNCHER` forces the choice for a test or
 * an operator who knows better: `herdr` probes even when the binary was not
 * detected on PATH, `none` skips the probe altogether.
 */

import type { DetectedTools } from "../detect.ts";
import { HerdrLauncher } from "./herdr.ts";

export async function chooseLauncher(tools: DetectedTools): Promise<HerdrLauncher | null> {
  const forced = process.env.SHAPE_LAUNCHER?.trim();
  if (forced !== undefined && forced !== "herdr" && forced !== "none") {
    console.error(`[bridge] SHAPE_LAUNCHER must be "herdr" or "none" (got "${forced}") — looking for herdr as usual`);
  }
  if (forced === "none") return null;
  const detected = tools.launchers.some((tool) => tool.id === "herdr");
  if (forced !== "herdr" && !detected) return null;
  return await HerdrLauncher.probe();
}
