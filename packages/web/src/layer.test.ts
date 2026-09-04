/**
 * Tests for the two cross-layer doors read from the build end: "covered by",
 * answered inside the correctness layer, and "serves", answered inside the
 * product layer — the same one relation as `__verifies__:` and `__realizes__:`
 * respectively, asked of the part instead of of the other side.
 *
 * Run (Node 26 type-stripping, no runner, no deps):
 *   node --test packages/web/src/layer.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { coveredByIdOf, coveredByPartOf, selectLayer, servesIdOf, servesPartOf } from "./layer.ts";
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

/** the mirror drill: one build bubble's other question, answered on the product layer */
function drillServes(graph: GraphDoc, buildId: string) {
  return selectLayer({ doc: graph, focus: servesIdOf(buildId), activity: new Set(), layer: "product" });
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

test("the serves drill holds exactly the capabilities the part keeps, and the chip counts them", () => {
  const graph = doc([
    node("sync-engine", { label: "the sync engine" }),
    node("editor", { label: "the editor" }),
    node("live-sync", { layer: "product", label: "work follows you", realizes: ["sync-engine"] }),
    node("offline", { layer: "product", label: "work offline", realizes: ["sync-engine"] }),
    node("writing", { layer: "product", label: "write things down", realizes: ["editor"] }),
  ]);

  const layer = drillServes(graph, "sync-engine");
  assert.equal(layer.served?.id, "sync-engine");
  assert.deepEqual(
    layer.nodes.map((entry) => entry.node.id),
    ["live-sync", "offline"],
  );
  assert.equal(
    layer.nodes.every((entry) => !entry.isMore),
    true,
  );
  assert.equal(layer.focus?.label, "served by the sync engine");

  // the same number the door on the build bubble shows
  const build = selectLayer({ doc: graph, focus: null, activity: new Set(), layer: "build" });
  assert.equal(build.nodes.find((entry) => entry.node.id === "sync-engine")?.serveCount, 2);
});

test("a capability realized by a parent is served by its children", () => {
  const graph = doc([
    node("store", { label: "the store" }),
    node("entry-store", { parentId: "store", label: "the entry store" }),
    node("keeping", { layer: "product", label: "nothing is lost", realizes: ["store"] }),
  ]);

  const layer = drillServes(graph, "entry-store");
  assert.equal(layer.served?.id, "entry-store");
  assert.deepEqual(
    layer.nodes.map((entry) => entry.node.id),
    ["keeping"],
  );

  const build = selectLayer({ doc: graph, focus: "store", activity: new Set(), layer: "build" });
  assert.equal(build.nodes.find((entry) => entry.node.id === "entry-store")?.serveCount, 1);
});

test("a part no capability names has no count and an empty layer, not a broken drill", () => {
  const graph = doc([
    node("importer", { label: "the importer" }),
    node("editor", { label: "the editor" }),
    node("writing", { layer: "product", label: "write things down", realizes: ["editor"] }),
  ]);

  const build = selectLayer({ doc: graph, focus: null, activity: new Set(), layer: "build" });
  assert.equal(build.nodes.find((entry) => entry.node.id === "importer")?.serveCount, 0);

  // the door is what hides; the layer behind it is merely empty
  const layer = drillServes(graph, "importer");
  assert.equal(layer.served?.id, "importer");
  assert.equal(layer.nodes.length, 0);
});

test("a serves drill at a part that is gone falls back to the whole product layer", () => {
  const graph = doc([
    node("editor", { label: "the editor" }),
    node("writing", { layer: "product", label: "write things down", realizes: ["editor"] }),
    node("sharing", { layer: "product", label: "share what you wrote" }),
  ]);

  const layer = drillServes(graph, "gone");
  assert.equal(layer.served, null);
  assert.equal(layer.trail.length, 0);
  assert.deepEqual(
    layer.nodes.map((entry) => entry.node.id),
    ["writing", "sharing"],
  );

  // the id survives a fold of the drill, and an empty tail names nothing
  assert.equal(servesPartOf("__more__:__serves__:x"), "x");
  assert.equal(servesPartOf("__serves__:"), null);
});

test("only a build bubble is asked what it serves", () => {
  const graph = doc([
    node("editor", { label: "the editor" }),
    node("writing", { layer: "product", label: "write things down", realizes: ["editor"] }),
  ]);

  const layer = drillServes(graph, "writing");
  assert.equal(layer.served, null);
});
