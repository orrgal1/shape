/**
 * Tests for the two planners that decide what the manager's `mgr config` must
 * say. They exist as pure functions because the reconciliation is the whole
 * risk of the manager pass: `mgr config add` appends without deduping, so a
 * planner that reports "changed" when nothing did rewrites the user's config
 * on every project open, and one that misses a stale entry sends builders at a
 * port this machine has since given away.
 *
 * Run (Node 26 type-stripping, no runner, no deps):
 *   node --test packages/bridge/src/agent/manager.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { planEnv, planOmpArgs } from "./manager.ts";

/** whatever THIS checkout's extension path is; the planners only compare paths */
const EXTENSION = "/repo/packages/link/src/omp-extension.ts";
const LINK = "ws://127.0.0.1:7777/link";

test("planOmpArgs: a config that already names this extension is left alone", () => {
  assert.equal(planOmpArgs(["--extension", EXTENSION], EXTENSION), null);
  assert.equal(planOmpArgs(["--approval-mode", "auto", "--extension", EXTENSION], EXTENSION), null);
});

test("planOmpArgs: an empty config gains exactly one pair", () => {
  assert.deepEqual(planOmpArgs([], EXTENSION), ["--extension", EXTENSION]);
});

test("planOmpArgs: another checkout's extension is replaced, not accumulated", () => {
  assert.deepEqual(planOmpArgs(["--extension", "/old/packages/link/src/omp-extension.ts"], EXTENSION), [
    "--extension",
    EXTENSION,
  ]);
});

test("planOmpArgs: duplicated pairs collapse to one", () => {
  const existing = ["--extension", EXTENSION, "--extension", EXTENSION];
  assert.deepEqual(planOmpArgs(existing, EXTENSION), ["--extension", EXTENSION]);
});

test("planOmpArgs: a stray extension value with no flag is dropped", () => {
  const existing = ["/half/written/packages/link/src/omp-extension.ts", "--approval-mode", "auto"];
  assert.deepEqual(planOmpArgs(existing, EXTENSION), ["--approval-mode", "auto", "--extension", EXTENSION]);
});

test("planOmpArgs: unrelated entries keep their order", () => {
  const existing = ["--approval-mode", "auto", "--extension", "/old/packages/link/src/omp-extension.ts", "--verbose"];
  assert.deepEqual(planOmpArgs(existing, EXTENSION), ["--approval-mode", "auto", "--verbose", "--extension", EXTENSION]);
});

test("planOmpArgs: an --extension of somebody else's extension is not touched", () => {
  const existing = ["--extension", "/somewhere/other-extension.ts"];
  assert.deepEqual(planOmpArgs(existing, EXTENSION), ["--extension", "/somewhere/other-extension.ts", "--extension", EXTENSION]);
});

test("planEnv: a config that already carries this link is left alone", () => {
  assert.equal(planEnv([`SHAPE_LINK=${LINK}`], LINK), null);
  assert.equal(planEnv(["EDITOR=vi", `SHAPE_LINK=${LINK}`], LINK), null);
});

test("planEnv: a stale link is replaced", () => {
  assert.deepEqual(planEnv(["SHAPE_LINK=ws://127.0.0.1:1234/link"], LINK), [`SHAPE_LINK=${LINK}`]);
});

test("planEnv: duplicated links collapse to one", () => {
  const existing = [`SHAPE_LINK=${LINK}`, "SHAPE_LINK=ws://127.0.0.1:1234/link"];
  assert.deepEqual(planEnv(existing, LINK), [`SHAPE_LINK=${LINK}`]);
});

test("planEnv: unrelated entries keep their order", () => {
  const existing = ["EDITOR=vi", "SHAPE_LINK=ws://127.0.0.1:1234/link", "PAGER=less"];
  assert.deepEqual(planEnv(existing, LINK), ["EDITOR=vi", "PAGER=less", `SHAPE_LINK=${LINK}`]);
});

test("planEnv: an empty config gains exactly the link", () => {
  assert.deepEqual(planEnv([], LINK), [`SHAPE_LINK=${LINK}`]);
});
