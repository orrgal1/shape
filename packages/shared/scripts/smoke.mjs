#!/usr/bin/env node
/**
 * Shared-contract smoke test for `applyOps` (packages/shared/src/index.ts).
 * Pure in-process checks, deterministic, sub-second: the `kind` round-trip,
 * one structured repair receipt per major rejection class (#5 shape),
 * unknown-`kind` degradation, and the product/build layer walls plus the
 * `realizes` link between them. Mirrors packages/bridge/scripts/smoke.mjs.
 */

import { canonicalJson, snapshotGraph } from "../src/delta.ts";
import { applyOps, emptyGraph, layerOf, productRootOf, realizersOf, servesOf } from "../src/index.ts";

const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

const node = (id, extra = {}) => ({
  id,
  parentId: null,
  label: id,
  summary: `promise of ${id}`,
  phase: "idea",
  ...extra,
});

/** a rejection carrying the #5 receipt contract: code + subject.path + concrete fixes */
function checkReceipt(name, res, code) {
  const r = res.rejections[0];
  check(`${name}: op rejected, none applied`, res.applied === 0 && res.rejections.length === 1, JSON.stringify(res));
  if (!r) return;
  check(`${name}: code is ${code}`, r.code === code, r.code);
  check(
    `${name}: subject.path points into the batch`,
    typeof r.subject?.path === "string" && r.subject.path.startsWith("/ops/0"),
    JSON.stringify(r.subject),
  );
  check(
    `${name}: supportedFixes non-empty strings`,
    Array.isArray(r.supportedFixes) && r.supportedFixes.length > 0 && r.supportedFixes.every((f) => typeof f === "string" && f.length > 0),
    JSON.stringify(r.supportedFixes),
  );
  check(`${name}: evidence object present`, r.evidence !== null && typeof r.evidence === "object", JSON.stringify(r.evidence));
}

// --- accept path: kind round-trips into the doc, rev increments -------------

{
  const doc = emptyGraph();
  const rev0 = doc.rev;
  const res = applyOps(doc, [{ op: "upsert_node", node: node("auth-service", { kind: "service" }) }]);
  check("accept: op applied without rejections", res.applied === 1 && res.rejections.length === 0, JSON.stringify(res));
  check("accept: rev incremented", doc.rev === rev0 + 1, `rev ${rev0} -> ${doc.rev}`);
  const stored = doc.nodes.find((n) => n.id === "auth-service");
  check("accept: kind round-trips into the doc", stored?.kind === "service", JSON.stringify(stored));
  // survives serialization, i.e. what the bridge persists / sends to the browser
  const wire = JSON.parse(JSON.stringify(doc));
  check("accept: kind survives JSON round-trip", wire.nodes[0]?.kind === "service", JSON.stringify(wire.nodes[0]));
}

// --- rejection receipts: one per major class --------------------------------

{
  const doc = emptyGraph();
  const res = applyOps(doc, [{ op: "upsert_node", node: node("orphan", { parentId: "nope" }) }]);
  checkReceipt("unknown parent", res, "op/unknown-parent");
  check("unknown parent: rev untouched", doc.rev === 0, `rev ${doc.rev}`);
}

{
  const doc = emptyGraph();
  applyOps(doc, [
    { op: "upsert_node", node: node("a") },
    { op: "upsert_node", node: node("b", { parentId: "a" }) },
  ]);
  const res = applyOps(doc, [{ op: "upsert_node", node: node("a", { parentId: "b" }) }]);
  checkReceipt("cycle", res, "op/cycle");
}

{
  const doc = emptyGraph();
  const res = applyOps(doc, [{ op: "upsert_node", node: node("Bad_Slug!") }]);
  checkReceipt("bad slug", res, "op/bad-slug");
}

// --- unknown / absent kind degrades to default (no receipt) -----------------

{
  const doc = emptyGraph();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("mystery", { kind: "blockchain" }) },
    { op: "upsert_node", node: node("plain") },
  ]);
  check("degrade: unknown kind still applies, no receipt", res.applied === 2 && res.rejections.length === 0, JSON.stringify(res));
  const mystery = doc.nodes.find((n) => n.id === "mystery");
  const plain = doc.nodes.find((n) => n.id === "plain");
  check("degrade: unknown kind dropped from doc", mystery !== undefined && !("kind" in mystery), JSON.stringify(mystery));
  check("degrade: absent kind stays absent", plain !== undefined && !("kind" in plain), JSON.stringify(plain));
}

// --- layers: product bubbles, realizes, and the two-layer walls -------------

/**
 * build parent `groups` with child `group-store`, plus the product root over
 * the parent — `share-costs` is the single top-level product bubble.
 */
function layeredDoc() {
  const doc = emptyGraph();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("groups") },
    { op: "upsert_node", node: node("group-store", { parentId: "groups" }) },
    { op: "upsert_node", node: node("share-costs", { layer: "product", realizes: ["groups"] }) },
  ]);
  return { doc, res };
}

{
  const { doc, res } = layeredDoc();
  check("layers: product node with realizes accepted", res.applied === 3 && res.rejections.length === 0, JSON.stringify(res));
  const product = doc.nodes.find((n) => n.id === "share-costs");
  const build = doc.nodes.find((n) => n.id === "groups");
  check("layers: product node stores layer + realizes", product?.layer === "product" && JSON.stringify(product?.realizes) === '["groups"]', JSON.stringify(product));
  check("layers: build node carries no layer marker", build !== undefined && !("layer" in build), JSON.stringify(build));
  check("layers: layerOf defaults to build", layerOf(build) === "build" && layerOf(product) === "product");
  check("layers: realizersOf lists the build node", JSON.stringify(realizersOf(doc, "share-costs")) === '["groups"]', JSON.stringify(realizersOf(doc, "share-costs")));
  check("layers: servesOf on the named build node", JSON.stringify(servesOf(doc, "groups")) === '["share-costs"]', JSON.stringify(servesOf(doc, "groups")));
  check(
    "layers: servesOf inherits through the ancestor rule",
    JSON.stringify(servesOf(doc, "group-store")) === '["share-costs"]',
    JSON.stringify(servesOf(doc, "group-store")),
  );
  check("layers: servesOf of a product node is empty", servesOf(doc, "share-costs").length === 0);
  check("layers: realizersOf of a build node is empty", realizersOf(doc, "groups").length === 0);
}

{
  const { doc } = layeredDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("split-fairly", { parentId: "share-costs", layer: "product", realizes: ["ghost"] }) },
  ]);
  checkReceipt("realizes missing id", res, "op/bad-realizes");
}

{
  const { doc } = layeredDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("split-fairly", { parentId: "share-costs", layer: "product", realizes: ["share-costs"] }) },
  ]);
  checkReceipt("realizes a product id", res, "op/bad-realizes");
}

{
  const { doc } = layeredDoc();
  const res = applyOps(doc, [{ op: "upsert_node", node: node("settle-up", { realizes: ["groups"] }) }]);
  checkReceipt("realizes on a build node", res, "op/bad-realizes");
}

// --- the product root: exactly one top-level product bubble ----------------

{
  const { doc } = layeredDoc();
  check("root: productRootOf finds the single top-level product bubble", productRootOf(doc)?.id === "share-costs", JSON.stringify(productRootOf(doc)));
  check("root: productRootOf is null with no product bubbles at all", productRootOf({ nodes: doc.nodes.filter((n) => layerOf(n) === "build") }) === null);

  const res = applyOps(doc, [{ op: "upsert_node", node: node("settle-up", { layer: "product", realizes: ["groups"] }) }]);
  checkReceipt("second top-level product bubble", res, "op/second-root");
  const receipt = res.rejections[0];
  check(
    "root: receipt names the existing root",
    receipt?.evidence?.rootId === "share-costs" && receipt.evidence.rootLabel === "share-costs" &&
      receipt.subject.path === "/ops/0/node/parentId" &&
      receipt.supportedFixes.some((f) => f.includes('"share-costs"')),
    JSON.stringify(receipt),
  );
  check("root: the rejected bubble never entered the doc", !doc.nodes.some((n) => n.id === "settle-up"));

  // the supported fix applies mechanically: same node, parented under the root
  const parented = applyOps(doc, [
    { op: "upsert_node", node: node("settle-up", { parentId: "share-costs", layer: "product", realizes: ["groups"] }) },
  ]);
  check("root: the same bubble is accepted under the root", parented.applied === 1 && parented.rejections.length === 0, JSON.stringify(parented));
  check("root: still exactly one root after the capability lands", productRootOf(doc)?.id === "share-costs");

  // moving the root itself back to top level is not a "second" root
  const same = applyOps(doc, [{ op: "upsert_node", node: node("share-costs", { layer: "product", realizes: ["groups"] }) }]);
  check("root: re-upserting the root at top level is fine", same.applied === 1 && same.rejections.length === 0, JSON.stringify(same));

  // a root with no realizes at all: it spans the whole build layer
  const bare = emptyGraph();
  const bareRes = applyOps(bare, [{ op: "upsert_node", node: node("bill-splitter", { layer: "product" }) }]);
  check("root: a product root without realizes is accepted", bareRes.applied === 1 && bareRes.rejections.length === 0, JSON.stringify(bareRes));
  check("root: productRootOf finds it", productRootOf(bare)?.id === "bill-splitter");
}

{
  // legacy graph: two top-level product bubbles already persisted -> no root
  const legacy = emptyGraph();
  legacy.nodes.push(
    { ...node("share-costs"), layer: "product" },
    { ...node("see-who-owes"), layer: "product" },
  );
  check("root: productRootOf is null for a legacy graph with two top-level product bubbles", productRootOf(legacy) === null);
  check("root: productRootOf is null for an empty graph", productRootOf(emptyGraph()) === null);
}

{
  const { doc } = layeredDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("stray", { layer: "product", parentId: "groups" }) },
  ]);
  checkReceipt("cross-layer parent", res, "op/cross-layer-parent");
}

{
  const { doc } = layeredDoc();
  const res = applyOps(doc, [
    { op: "upsert_edge", edge: { id: "share-costs--groups", source: "share-costs", target: "groups", kind: "depends" } },
  ]);
  checkReceipt("cross-layer edge", res, "op/cross-layer-edge");
}

{
  const { doc } = layeredDoc();
  const blocked = applyOps(doc, [{ op: "remove_node", id: "group-store" }, { op: "remove_node", id: "groups" }]);
  check("realized build node: only the unreferenced child removed", blocked.applied === 1 && blocked.rejections.length === 1, JSON.stringify(blocked));
  const receipt = blocked.rejections[0];
  check("realized build node: code is op/node-realized", receipt?.code === "op/node-realized", JSON.stringify(receipt));
  check(
    "realized build node: receipt names the product node",
    JSON.stringify(receipt?.evidence?.realizedBy) === '["share-costs"]',
    JSON.stringify(receipt?.evidence),
  );
  check("realized build node: still in the doc", doc.nodes.some((n) => n.id === "groups"));
  const freed = applyOps(doc, [
    { op: "upsert_node", node: node("share-costs", { layer: "product", realizes: [] }) },
    { op: "remove_node", id: "groups" },
  ]);
  check("realized build node: removable once the product node drops it", freed.applied === 2 && freed.rejections.length === 0, JSON.stringify(freed));
  check("realized build node: gone from the doc", !doc.nodes.some((n) => n.id === "groups"));
}

{
  // flipping a still-realized build node onto the product layer would dangle the link
  const { doc } = layeredDoc();
  const res = applyOps(doc, [{ op: "upsert_node", node: node("groups", { layer: "product" }) }]);
  checkReceipt("realized build node flipped to product", res, "op/node-realized");
}

{
  // an upsert that omits `layer` leaves the bubble on the layer it already had
  const { doc } = layeredDoc();
  applyOps(doc, [{ op: "upsert_node", node: node("share-costs", { realizes: ["groups"], status: "refreshed" }) }]);
  const product = doc.nodes.find((n) => n.id === "share-costs");
  check("layers: layer sticks across an upsert that omits it", product?.layer === "product" && product?.status === "refreshed", JSON.stringify(product));
}

{
  const implicit = emptyGraph();
  const explicit = emptyGraph();
  applyOps(implicit, [{ op: "upsert_node", node: node("groups", { kind: "store" }) }]);
  applyOps(explicit, [{ op: "upsert_node", node: node("groups", { kind: "store", layer: "build" }) }]);
  const at = "2026-09-03T00:00:00.000Z";
  check(
    "canonical: build node with and without an explicit layer snapshot identically",
    canonicalJson(snapshotGraph(implicit, at)) === canonicalJson(snapshotGraph(explicit, at)),
    `${canonicalJson(snapshotGraph(implicit, at))} vs ${canonicalJson(snapshotGraph(explicit, at))}`,
  );
  const { doc } = layeredDoc();
  applyOps(doc, [
    { op: "upsert_node", node: node("share-costs", { layer: "product", realizes: ["group-store", "groups"] }) },
  ]);
  const snap = snapshotGraph(doc, at);
  const canonicalProduct = snap.nodes.find((n) => n.id === "share-costs");
  check(
    "canonical: product node keeps its layer and sorts realizes",
    canonicalProduct?.layer === "product" && JSON.stringify(canonicalProduct?.realizes) === '["group-store","groups"]',
    JSON.stringify(canonicalProduct),
  );
}

console.log(`\n${results.join("\n")}\n`);
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
