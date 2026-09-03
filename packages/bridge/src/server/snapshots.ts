/**
 * Revision snapshots: one canonical GraphSnapshot per `rev` under
 * <dir>/revisions/<rev>.json — where that directory is is the storage's
 * business (`server/storage.ts`) — so the browser can diff any two points in
 * the canvas's history.
 *
 * A revision is immutable once written (a rev never means two different graphs),
 * writes are serialized and atomic, and every failure is reported and swallowed:
 * losing a snapshot must never break the turn that produced it.
 */

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { snapshotGraph } from "../../../shared/src/delta.ts";
import type { GraphDoc, GraphSnapshot, RevisionInfo } from "../../../shared/src/index.ts";

/** how many newest revisions survive a prune */
const RETENTION = 50;

const REV_FILE_RE = /^(\d+)\.json$/;

/** Boundary validator: snapshots on disk were written by an older bridge. */
function parseSnapshot(raw: unknown, rev: number): GraphSnapshot | null {
  if (raw === null || typeof raw !== "object") return null;
  if (!("nodes" in raw) || !Array.isArray(raw.nodes)) return null;
  if (!("edges" in raw) || !Array.isArray(raw.edges)) return null;
  const at = "at" in raw && typeof raw.at === "string" ? raw.at : "";
  return {
    rev: "rev" in raw && typeof raw.rev === "number" ? raw.rev : rev,
    at,
    nodes: raw.nodes as GraphSnapshot["nodes"],
    edges: raw.edges as GraphSnapshot["edges"],
  };
}

export class SnapshotStore {
  readonly #dir: string;
  #writing: Promise<RevisionInfo | null> = Promise.resolve(null);

  constructor(dir: string) {
    this.#dir = join(dir, "revisions");
  }

  /**
   * Snapshot the doc's current rev. Serialized behind every earlier save.
   * Resolves with the new revision, or null when that rev is already on disk or
   * the write failed — callers broadcast only on a non-null result.
   */
  save(doc: GraphDoc): Promise<RevisionInfo | null> {
    const snapshot = snapshotGraph(doc);
    const done = this.#writing.then(() => this.#write(snapshot));
    this.#writing = done;
    return done;
  }

  async list(): Promise<RevisionInfo[]> {
    const revs = await this.#revs();
    const infos = await Promise.all(revs.map((rev) => this.#info(rev)));
    return infos.sort((a, b) => a.rev - b.rev);
  }

  async load(rev: number): Promise<GraphSnapshot | null> {
    let text: string;
    try {
      text = await readFile(join(this.#dir, `${rev}.json`), "utf8");
    } catch {
      return null;
    }
    try {
      return parseSnapshot(JSON.parse(text), rev);
    } catch {
      console.error(`[bridge] ignoring unparseable revision ${rev}`);
      return null;
    }
  }

  /** Never throws: a failed snapshot is logged and reported as null. */
  async #write(snapshot: GraphSnapshot): Promise<RevisionInfo | null> {
    const file = join(this.#dir, `${snapshot.rev}.json`);
    const tmp = `${file}.tmp`;
    try {
      await mkdir(this.#dir, { recursive: true });
      // a rev is immutable: never overwrite a snapshot that already exists
      const occupied = await stat(file).then(
        () => true,
        () => false,
      );
      if (occupied) return null;
      await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    } catch (err) {
      console.error(`[bridge] failed to write revision ${snapshot.rev}: ${String(err)}`);
      return null;
    }
    await this.#prune();
    return { rev: snapshot.rev, at: snapshot.at };
  }

  /** Drop everything but the newest RETENTION revisions. */
  async #prune(): Promise<void> {
    const revs = await this.#revs();
    if (revs.length <= RETENTION) return;
    revs.sort((a, b) => a - b);
    for (const rev of revs.slice(0, revs.length - RETENTION)) {
      try {
        await unlink(join(this.#dir, `${rev}.json`));
      } catch (err) {
        console.error(`[bridge] failed to prune revision ${rev}: ${String(err)}`);
      }
    }
  }

  /** rev numbers present on disk, unordered; [] when the dir is absent. */
  async #revs(): Promise<number[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }
    const revs: number[] = [];
    for (const name of names) {
      const match = REV_FILE_RE.exec(name);
      if (match !== null) revs.push(Number(match[1]));
    }
    return revs;
  }

  /** `at` comes from the snapshot itself; mtime is the fallback for old files. */
  async #info(rev: number): Promise<RevisionInfo> {
    const file = join(this.#dir, `${rev}.json`);
    const snapshot = await this.load(rev);
    if (snapshot !== null && snapshot.at !== "") return { rev, at: snapshot.at };
    try {
      const stats = await stat(file);
      return { rev, at: stats.mtime.toISOString() };
    } catch {
      return { rev, at: new Date(0).toISOString() };
    }
  }
}
