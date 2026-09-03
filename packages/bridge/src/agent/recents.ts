/**
 * Recently-targeted projects: ~/.shape/recents.json, most-recent first,
 * deduped, capped. `SHAPE_HOME` overrides the home dir (tests).
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CAP = 10;

function recentsFile(): string {
  const home = process.env.SHAPE_HOME ?? homedir();
  return join(home, ".shape", "recents.json");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Stored paths, dropping any whose directory has disappeared. */
export async function loadRecents(): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(recentsFile(), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const alive: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string" || alive.includes(entry)) continue;
    if (await isDirectory(entry)) alive.push(entry);
  }
  return alive.slice(0, CAP);
}

/** Promote `path` to the front and persist. Returns the new list. */
export async function pushRecent(path: string): Promise<string[]> {
  const existing = await loadRecents();
  const next = [path, ...existing.filter((entry) => entry !== path)].slice(0, CAP);
  const file = recentsFile();
  try {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (err) {
    console.error(`[bridge] failed to persist recents: ${String(err)}`);
  }
  return next;
}
