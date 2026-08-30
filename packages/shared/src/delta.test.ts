/**
 * Tests for the pure snapshot/delta layer.
 *
 * Run (Node 26 type-stripping, no runner, no deps):
 *   node --test packages/shared/src/delta.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, diffSnapshots, snapshotGraph } from "./delta.ts";
import type { GraphEdge, IntentNode } from "./index.ts";

const AT = "2026-08-30T00:00:00.000Z";

function node(id: string, extra: Partial<IntentNode> = {}): IntentNode {
  return { id, parentId: null, label: id, summary: `${id} does a thing.`, phase: "concept", ...extra };
}

function edge(id: string, source: string, target: string, extra: Partial<GraphEdge> = {}): GraphEdge {
  return { id, source, target, kind: "depends", ...extra };
}

test("snapshotGraph is canonical: order-independent and undefined optionals dropped", () => {
  const a = snapshotGraph(
    {
      rev: 3,
      nodes: [
        node("beta", { codeRefs: ["packages/web", "packages/bridge"] }),
        node("alpha", { status: undefined, modelRole: undefined } as unknown as Partial<IntentNode>),
      ],
      edges: [
        edge("beta--alpha", "beta", "alpha"),
        edge("alpha--beta", "alpha", "beta", { label: undefined } as unknown as Partial<GraphEdge>),
      ],
    },
    AT,
  );
  const b = snapshotGraph(
    {
      rev: 3,
      nodes: [node("alpha"), node("beta", { codeRefs: ["packages/bridge", "packages/web"] })],
      edges: [edge("alpha--beta", "alpha", "beta"), edge("beta--alpha", "beta", "alpha")],
    },
    AT,
  );

  assert.deepEqual(
    a.nodes.map((n) => n.id),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    a.edges.map((e) => e.id),
    ["alpha--beta", "beta--alpha"],
  );
  assert.deepEqual(a.nodes[1]?.codeRefs, ["packages/bridge", "packages/web"]);
  assert.equal(Object.hasOwn(a.nodes[0] ?? {}, "status"), false);
  assert.equal(Object.hasOwn(a.edges[0] ?? {}, "label"), false);
  assert.equal(canonicalJson(a), canonicalJson(b));
});

test("canonicalJson sorts object keys and preserves array order", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, 1] }), '{"a":[2,1],"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test("snapshotGraph defaults `at` to a timestamp", () => {
  const snap = snapshotGraph({ rev: 1, nodes: [], edges: [] });
  assert.equal(Number.isNaN(Date.parse(snap.at)), false);
});

test("diffSnapshots reports exactly the added, removed and changed entities", () => {
  const before = snapshotGraph(
    {
      rev: 4,
      nodes: [node("api"), node("db"), node("legacy")],
      edges: [edge("api--db", "api", "db"), edge("api--legacy", "api", "legacy")],
    },
    AT,
  );
  // add node "cache" + edge "api--cache"; remove node "legacy" + its edge; change db's summary
  const after = snapshotGraph(
    {
      rev: 5,
      nodes: [node("cache"), node("api"), node("db", { summary: "Keeps the saved answers." })],
      edges: [edge("api--cache", "api", "cache"), edge("api--db", "api", "db")],
    },
    AT,
  );

  const delta = diffSnapshots(before, after);

  assert.equal(delta.revA, 4);
  assert.equal(delta.revB, 5);
  assert.deepEqual(
    delta.nodes.added.map((n) => n.id),
    ["cache"],
  );
  assert.deepEqual(
    delta.nodes.removed.map((n) => n.id),
    ["legacy"],
  );
  assert.deepEqual(
    delta.nodes.changed.map((c) => c.before.id),
    ["db"],
  );
  assert.equal(delta.nodes.changed[0]?.before.summary, "db does a thing.");
  assert.equal(delta.nodes.changed[0]?.after.summary, "Keeps the saved answers.");

  assert.deepEqual(
    delta.edges.added.map((e) => e.id),
    ["api--cache"],
  );
  assert.deepEqual(
    delta.edges.removed.map((e) => e.id),
    ["api--legacy"],
  );
  assert.deepEqual(delta.edges.changed, []);
});

test("diffSnapshots sorts every bucket by id", () => {
  const before = snapshotGraph({ rev: 1, nodes: [node("gone-b"), node("gone-a")], edges: [] }, AT);
  const after = snapshotGraph({ rev: 2, nodes: [node("new-b"), node("new-a")], edges: [] }, AT);
  const delta = diffSnapshots(before, after);

  assert.deepEqual(
    delta.nodes.added.map((n) => n.id),
    ["new-a", "new-b"],
  );
  assert.deepEqual(
    delta.nodes.removed.map((n) => n.id),
    ["gone-a", "gone-b"],
  );
});

test("edge label and node status changes are detected", () => {
  const before = snapshotGraph(
    { rev: 1, nodes: [node("api", { status: "wiring it up" })], edges: [edge("api--api", "api", "api")] },
    AT,
  );
  const after = snapshotGraph(
    {
      rev: 2,
      nodes: [node("api")],
      edges: [edge("api--api", "api", "api", { label: "talks to itself" })],
    },
    AT,
  );
  const delta = diffSnapshots(before, after);

  assert.equal(delta.nodes.changed.length, 1);
  assert.equal(delta.nodes.changed[0]?.before.status, "wiring it up");
  assert.equal(delta.nodes.changed[0]?.after.status, undefined);
  assert.equal(delta.edges.changed.length, 1);
  assert.equal(delta.edges.changed[0]?.after.label, "talks to itself");
  assert.deepEqual(delta.nodes.added, []);
  assert.deepEqual(delta.nodes.removed, []);
});

test("diff of identical snapshots is empty", () => {
  const snap = snapshotGraph(
    { rev: 7, nodes: [node("api"), node("db")], edges: [edge("api--db", "api", "db", { label: "asks for rows" })] },
    AT,
  );
  const delta = diffSnapshots(snap, snap);

  assert.deepEqual(delta.nodes, { added: [], removed: [], changed: [] });
  assert.deepEqual(delta.edges, { added: [], removed: [], changed: [] });
  assert.equal(delta.revA, 7);
  assert.equal(delta.revB, 7);
});
