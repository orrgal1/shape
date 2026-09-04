/**
 * Tests for the "covered by" drill: the fourth cross-layer door, read from the
 * build end and answered inside the correctness layer.
 *
 * Run (Node 26 type-stripping, no runner, no deps):
 *   node --test packages/web/src/layer.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { coveredByIdOf, coveredByPartOf, selectLayer } from "./layer.ts";
import { emptyGraph, type GraphDoc, type IntentNode } from "../../shared/src/index.ts";

function node(id: string, extra: Partial<IntentNode> = {}): IntentNode {
  return { id, parentId: null, label: id, summary: `${id} does a thing.`, phase: "built", ...extra };
}

function doc(nodes: IntentNode[]): GraphDoc {
  return { ...emptyGraph(), rev: 1, nodes };
}

/** the drill itself: one build bubble's question, answered on the correctness layer */
function drill(graph: GraphDoc, buildId: string) {
  return selectLayer({ doc: graph, focus: coveredByIdOf(buildId), activity: new Set(), layer: "correctness" });
}

test("the drill holds exactly the checks that name the part, and the chip counts them", () => {
  const graph = doc([
    node("sync-engine", { label: "the sync engine" }),
    node("editor", { label: "the editor" }),
    node("sync-smoke", { layer: "correctness", label: "the sync smoke run", verifies: ["sync-engine"] }),
    node("sync-unit", { layer: "correctness", label: "the sync unit tests", verifies: ["sync-engine"] }),
    node("editor-suite", { layer: "correctness", label: "the editor suite", verifies: ["editor"] }),
  ]);

  const layer = drill(graph, "sync-engine");
  assert.equal(layer.covered?.id, "sync-engine");
  assert.deepEqual(
    layer.nodes.map((entry) => entry.node.id),
    ["sync-smoke", "sync-unit"],
  );
  assert.equal(
    layer.nodes.every((entry) => !entry.isMore),
    true,
  );
  assert.equal(layer.focus?.label, "covers the sync engine");

  // the same number the door on the build bubble shows
  const build = selectLayer({ doc: graph, focus: null, activity: new Set(), layer: "build" });
  assert.equal(build.nodes.find((entry) => entry.node.id === "sync-engine")?.coverCount, 2);
});

test("a check that names a parent covers its children", () => {
  const graph = doc([
    node("store", { label: "the store" }),
    node("entry-store", { parentId: "store", label: "the entry store" }),
    node("store-suite", { layer: "correctness", label: "the store suite", verifies: ["store"] }),
  ]);

  const layer = drill(graph, "entry-store");
  assert.equal(layer.covered?.id, "entry-store");
  assert.deepEqual(
    layer.nodes.map((entry) => entry.node.id),
    ["store-suite"],
  );

  const build = selectLayer({ doc: graph, focus: "store", activity: new Set(), layer: "build" });
  assert.equal(build.nodes.find((entry) => entry.node.id === "entry-store")?.coverCount, 1);
});

test("a part no check names has no count and an empty layer, not a broken drill", () => {
  const graph = doc([
    node("importer", { label: "the importer" }),
    node("editor", { label: "the editor" }),
    node("editor-suite", { layer: "correctness", label: "the editor suite", verifies: ["editor"] }),
  ]);

  const build = selectLayer({ doc: graph, focus: null, activity: new Set(), layer: "build" });
  assert.equal(build.nodes.find((entry) => entry.node.id === "importer")?.coverCount, 0);

  // the door is what hides; the layer behind it is merely empty
  const layer = drill(graph, "importer");
  assert.equal(layer.covered?.id, "importer");
  assert.equal(layer.nodes.length, 0);
});

test("a drill at a part that is gone falls back to the whole correctness layer", () => {
  const graph = doc([
    node("editor", { label: "the editor" }),
    node("editor-suite", { layer: "correctness", label: "the editor suite", verifies: ["editor"] }),
    node("uptime", { layer: "correctness", label: "the uptime monitor" }),
  ]);

  const layer = drill(graph, "gone");
  assert.equal(layer.covered, null);
  assert.equal(layer.trail.length, 0);
  assert.deepEqual(
    layer.nodes.map((entry) => entry.node.id),
    ["editor-suite", "uptime"],
  );

  // the id survives a fold of the drill, and an empty tail names nothing
  assert.equal(coveredByPartOf("__more__:__coveredby__:x"), "x");
  assert.equal(coveredByPartOf("__coveredby__:"), null);
});

test("only a build bubble is asked what covers it", () => {
  const graph = doc([
    node("editor", { label: "the editor" }),
    node("editor-suite", { layer: "correctness", label: "the editor suite", verifies: ["editor"] }),
  ]);

  const layer = drill(graph, "editor-suite");
  assert.equal(layer.covered, null);
});
