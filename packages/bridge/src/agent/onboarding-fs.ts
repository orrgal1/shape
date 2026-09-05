/**
 * Brownfield onboarding, agent half (docs/onboarding.md): the mechanics that need
 * the target project's disk — the bounded source probe that answers
 * `targetHasCode`, and the mechanical skeleton derived from the reality layer.
 *
 * That skeleton is the whole of the automatic map: the room asks for it when a
 * project with code arrives on an empty canvas, applies the ops and is done.
 * Nothing here asks an agent to explain anything.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasOp, RealityLayer } from "../../../shared/src/index.ts";

/** never walked: build output, vendored trees and Shape's own state */
export const SKIP_DIRS: Record<string, true> = {
  ".git": true,
  ".next": true,
  ".venv": true,
  ".shape": true,
  __pycache__: true,
  build: true,
  coverage: true,
  dist: true,
  node_modules: true,
  out: true,
  target: true,
  venv: true,
};

const SOURCE_EXTENSIONS: Record<string, true> = {
  ".go": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".py": true,
  ".rs": true,
  ".ts": true,
  ".tsx": true,
};

/** node-id slug: ^[a-z0-9][a-z0-9-]*$ */
function slug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return cleaned.length === 0 ? "pkg" : cleaned;
}

/**
 * Cheap bounded source scan — the `targetHasCode` fallback for repos the reality
 * extractor cannot describe (non-pnpm, non-TS).
 */
export async function hasSourceCode(cwd: string): Promise<boolean> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < 200) {
    const next = queue.shift();
    if (next === undefined) break;
    visited++;
    let entries;
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") && SKIP_DIRS[entry.name] !== true) continue;
        if (SKIP_DIRS[entry.name] === true) continue;
        if (next.depth < 6) queue.push({ dir: join(next.dir, entry.name), depth: next.depth + 1 });
        continue;
      }
      const dot = entry.name.lastIndexOf(".");
      if (dot > 0 && SOURCE_EXTENSIONS[entry.name.slice(dot)] === true) return true;
    }
  }
  return false;
}

async function packageDescription(cwd: string, dir: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(cwd, dir, "package.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !("description" in parsed)) return null;
  const description = parsed.description;
  if (typeof description !== "string") return null;
  const oneLine = description.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return null;
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
}

/**
 * Stage 1: one `component` node per workspace package plus a `depends` edge per
 * cross-package reality edge. Ground truth before the model says a word.
 *
 * Deliberately FLAT: mechanics know packages, not domains. The survey turn owns
 * grouping (prompt rule 4 — 3-5 bubbles per layer), so this stays one bubble per
 * package however many there are.
 */
export async function synthesizeSkeleton(cwd: string, reality: RealityLayer): Promise<CanvasOp[]> {
  const idByRealityId: Record<string, string> = {};
  const taken = new Set<string>();
  const ops: CanvasOp[] = [];

  for (const pkg of reality.nodes) {
    const base = slug(pkg.label);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    idByRealityId[pkg.id] = id;

    const shortName = pkg.label.slice(pkg.label.lastIndexOf("/") + 1);
    const description = await packageDescription(cwd, pkg.dir);
    ops.push({
      op: "upsert_node",
      node: {
        id,
        parentId: null,
        label: shortName.length > 60 ? shortName.slice(0, 60) : shortName,
        summary: description ?? `Workspace package at ${pkg.dir} — nothing has described it yet.`,
        phase: "built",
        codeRefs: [pkg.dir],
      },
    });
  }

  const seen = new Set<string>();
  for (const edge of reality.edges) {
    const source = idByRealityId[edge.source];
    const target = idByRealityId[edge.target];
    if (source === undefined || target === undefined || source === target) continue;
    const id = `${source}--${target}`;
    if (seen.has(id)) continue;
    seen.add(id);
    ops.push({ op: "upsert_edge", edge: { id, source, target, kind: "depends" } });
  }

  return ops;
}
