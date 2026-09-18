/**
 * Revision snapshots: one canonical GraphSnapshot per `rev` of ONE branch's
 * canvas, so the browser can diff any two points in that branch's history.
 * Where they are kept is the storage's business (`server/storage.ts`).
 *
 * A revision is immutable once written (a rev never means two different graphs)
 * and every failure is reported and swallowed: losing a snapshot must never
 * break the turn that produced it.
 */

import { snapshotGraph } from "../../../shared/src/delta.ts";
import type { GraphDoc, GraphSnapshot, RevisionInfo } from "../../../shared/src/index.ts";
import type { Storage } from "./storage.ts";

export class SnapshotStore {
  readonly #storage: Storage;
  readonly #tenant: string;
  readonly #key: string;
  readonly #branch: string;

  constructor(storage: Storage, tenant: string, key: string, branch: string) {
    this.#storage = storage;
    this.#tenant = tenant;
    this.#key = key;
    this.#branch = branch;
  }

  /**
   * Snapshot the doc's current rev. Resolves with the new revision, or null
   * when that rev is already stored or the write failed — callers broadcast
   * only on a non-null result.
   */
  async save(doc: GraphDoc): Promise<RevisionInfo | null> {
    const snapshot = snapshotGraph(doc);
    try {
      const stored = await this.#storage.saveRevision(this.#tenant, this.#key, this.#branch, snapshot);
      return stored ? { rev: snapshot.rev, at: snapshot.at } : null;
    } catch (err) {
      console.error(`[bridge] failed to write revision ${snapshot.rev}: ${String(err)}`);
      return null;
    }
  }

  list(): Promise<RevisionInfo[]> {
    return this.#storage.listRevisions(this.#tenant, this.#key, this.#branch);
  }

  load(rev: number): Promise<GraphSnapshot | null> {
    return this.#storage.loadRevision(this.#tenant, this.#key, this.#branch, rev);
  }
}
