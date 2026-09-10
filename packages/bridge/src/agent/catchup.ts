/** One machine-wide queue for explicitly requested Shape synchronization, never user sessions. */
import type { CatchUpState } from "../../../shared/src/index.ts";
import type { HerdrLauncher } from "./launcher/herdr.ts";
import { OMP_EXTENSION } from "./manager.ts";
import { canonicalDir } from "./worktrees.ts";

type CanvasResult = { text: string; isError: boolean };

export interface CatchUpJob {
  id: string;
  worktree: string;
  project: { path: string; label: string };
  prompt: string;
  since: number;
  link: string;
  launcher: HerdrLauncher | null;
  /** Reject code movement both before launch and before accepting its completed work. */
  current: () => Promise<boolean>;
  canvas: (args: unknown) => Promise<CanvasResult>;
  state: (state: CatchUpState) => void;
}

interface QueuedJob {
  job: CatchUpJob;
  controller: AbortController;
  calls: Set<Promise<CanvasResult>>;
  accepting: boolean;
}

export class CatchUpQueue {
  readonly #queued = new Map<string, QueuedJob>();
  #running: QueuedJob | null = null;
  #stopped = false;

  enqueue(job: CatchUpJob): void {
    if (this.#stopped) return;
    const key = canonicalDir(job.worktree);
    const existing = this.#queued.get(key) ?? (this.#running !== null && canonicalDir(this.#running.job.worktree) === key ? this.#running : undefined);
    if (existing !== undefined) {
      if (existing.job.id !== job.id) job.state({ state: "failed", reason: "a synchronization is already pending for this worktree", at: Date.now() });
      return;
    }
    const entry: QueuedJob = { job, controller: new AbortController(), calls: new Set(), accepting: false };
    this.#queued.set(key, entry);
    job.state({ state: "queued", at: Date.now() });
    void this.#drain();
  }

  /** Query-route capability: never route a synchronization through normal session observation. */
  async canvas(id: string, cwd: string, args: unknown): Promise<CanvasResult> {
    const entry = this.#running;
    if (entry === null || entry.job.id !== id || !entry.accepting || entry.controller.signal.aborted || canonicalDir(cwd) !== canonicalDir(entry.job.worktree)) {
      return { text: "unknown, inactive or foreign Shape synchronization job", isError: true };
    }
    const call = (async (): Promise<CanvasResult> => {
      if (!(await entry.job.current()) || entry.controller.signal.aborted) return { text: "synchronization HEAD changed or job was cancelled", isError: true };
      return entry.job.canvas(args);
    })();
    entry.calls.add(call);
    try {
      return await call;
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    } finally {
      entry.calls.delete(call);
    }
  }

  cancel(id: string): void {
    for (const [key, entry] of this.#queued) {
      if (entry.job.id !== id) continue;
      this.#queued.delete(key);
      entry.controller.abort();
      entry.job.state({ state: "failed", reason: "synchronization cancelled", at: Date.now() });
    }
    if (this.#running?.job.id === id) {
      this.#running.accepting = false;
      this.#running.controller.abort();
    }
  }

  stop(): void {
    this.#stopped = true;
    for (const entry of [...this.#queued.values()]) this.cancel(entry.job.id);
    if (this.#running !== null) this.cancel(this.#running.job.id);
  }

  async #drain(): Promise<void> {
    if (this.#stopped || this.#running !== null) return;
    let next: QueuedJob | undefined;
    for (const entry of this.#queued.values()) if (next === undefined || entry.job.since < next.job.since) next = entry;
    if (next === undefined) return;
    this.#queued.delete(canonicalDir(next.job.worktree));
    this.#running = next;
    const { job, controller } = next;
    try {
      if (job.launcher === null) throw new Error("herdr is unavailable for Shape synchronization");
      if (!(await job.current())) throw new Error("worktree HEAD changed before synchronization started");
      if (controller.signal.aborted) throw new Error("synchronization cancelled");
      next.accepting = true;
      job.state({ state: "running", at: Date.now() });
      const url = new URL(job.link);
      url.searchParams.set("job", job.id);
      await job.launcher.sync(job.project, {
        cwd: job.worktree,
        link: url.toString(),
        extension: OMP_EXTENSION,
        prompt: job.prompt,
        signal: controller.signal,
      });
      next.accepting = false;
      await Promise.all(next.calls);
      if (controller.signal.aborted) throw new Error("synchronization cancelled");
      if (!(await job.current())) throw new Error("worktree HEAD changed during synchronization");
      // The room alone knows whether this job actually persisted a canvas mutation.
      job.state({ state: "idle", at: Date.now() });
    } catch (err) {
      job.state({ state: "failed", reason: err instanceof Error ? err.message : String(err), at: Date.now() });
    } finally {
      next.accepting = false;
      await Promise.allSettled(next.calls);
      // Cancellation does not release the machine slot until herdr finished cleanup.
      this.#running = null;
      void this.#drain();
    }
  }
}
