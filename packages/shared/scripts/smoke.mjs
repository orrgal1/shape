#!/usr/bin/env node
/**
 * Shared-contract smoke test for `applyOps` (packages/shared/src/index.ts).
 * Pure in-process checks, deterministic, sub-second: the `kind` round-trip,
 * one structured repair receipt per major rejection class (#5 shape),
 * unknown-`kind` degradation, the product/build/infra/correctness layer walls with
 * the `realizes`, `hosts` and `verifies` links between them, the verification
 * status rules, the link gaps that make connection the default, and
 * `<file>#<Name>` symbol refs.
 * Mirrors packages/bridge/scripts/smoke.mjs.
 */

import { canonicalJson, diffSnapshots, snapshotGraph } from "../src/delta.ts";
import {
  applyOps,
  capabilityVerification,
  emptyGraph,
  hostsOf,
  LAYERS,
  layerOf,
  LINKED_PHASES,
  linkGapsOf,
  parseNext,
  productRootOf,
  realizersOf,
  runsOnOf,
  servesOf,
  symbolRefOf,
  verificationOf,
  verifiedOf,
  verifiersOf,
} from "../src/index.ts";

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

// --- the infra layer: where it runs, and the hosts link back to build -------

/** the layered doc plus `main-database`, an infra bubble running `groups` */
function infraDoc() {
  const { doc } = layeredDoc();
  const res = applyOps(doc, [
    {
      op: "upsert_node",
      node: node("main-database", { layer: "infra", kind: "database", codeRefs: ["docker-compose.yml"], hosts: ["groups"] }),
    },
  ]);
  return { doc, res };
}

{
  const { doc, res } = infraDoc();
  check("infra: infra node with hosts accepted", res.applied === 1 && res.rejections.length === 0, JSON.stringify(res));
  const infra = doc.nodes.find((n) => n.id === "main-database");
  check(
    "infra: node stores layer, kind and hosts",
    infra?.layer === "infra" && infra?.kind === "database" && JSON.stringify(infra?.hosts) === '["groups"]',
    JSON.stringify(infra),
  );
  check("infra: layerOf reads the third layer", layerOf(infra) === "infra");
  check(
    "infra: hostsOf lists the build nodes it runs",
    hostsOf(doc, "main-database").map((n) => n.id).join(",") === "groups",
    JSON.stringify(hostsOf(doc, "main-database").map((n) => n.id)),
  );
  check(
    "infra: runsOnOf on the named build node",
    runsOnOf(doc, "groups").map((n) => n.id).join(",") === "main-database",
    JSON.stringify(runsOnOf(doc, "groups").map((n) => n.id)),
  );
  check(
    "infra: runsOnOf inherits through the ancestor rule",
    runsOnOf(doc, "group-store").map((n) => n.id).join(",") === "main-database",
    JSON.stringify(runsOnOf(doc, "group-store").map((n) => n.id)),
  );
  check("infra: runsOnOf of an infra node is empty", runsOnOf(doc, "main-database").length === 0);
  check("infra: hostsOf of a build node is empty", hostsOf(doc, "groups").length === 0);
  check("infra: productRootOf ignores the infra layer", productRootOf(doc)?.id === "share-costs");
  check(
    "infra: hosts sticks across an upsert that omits it",
    (() => {
      applyOps(doc, [{ op: "upsert_node", node: node("main-database", { status: "warming up" }) }]);
      const same = doc.nodes.find((n) => n.id === "main-database");
      return same?.layer === "infra" && JSON.stringify(same?.hosts) === '["groups"]';
    })(),
    JSON.stringify(doc.nodes.find((n) => n.id === "main-database")),
  );
}

{
  const { doc } = layeredDoc();
  const res = applyOps(doc, [{ op: "upsert_node", node: node("worker", { hosts: ["groups"] }) }]);
  checkReceipt("hosts on a build node", res, "op/bad-hosts");
}

{
  const { doc } = layeredDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("main-database", { layer: "infra", hosts: ["share-costs"] }) },
  ]);
  checkReceipt("hosts naming a product node", res, "op/bad-hosts");
  check(
    "hosts naming a product node: receipt names the layer it found",
    res.rejections[0]?.evidence?.targetLayer === "product",
    JSON.stringify(res.rejections[0]?.evidence),
  );
}

{
  const { doc } = layeredDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("main-database", { layer: "infra", hosts: ["ghost"] }) },
  ]);
  checkReceipt("hosts naming an unknown id", res, "op/bad-hosts");
}

{
  const { doc } = layeredDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("main-database", { layer: "infra", hosts: ["groups", "groups"] }) },
  ]);
  checkReceipt("hosts listing an id twice", res, "op/bad-hosts");
}

{
  const { doc } = layeredDoc();
  const many = Array.from({ length: 41 }, (_, i) => `part-${i}`);
  applyOps(doc, many.map((id) => ({ op: "upsert_node", node: node(id) })));
  const res = applyOps(doc, [{ op: "upsert_node", node: node("main-database", { layer: "infra", hosts: many }) }]);
  checkReceipt("hosts over the cap of 40", res, "op/bad-hosts");
  check("hosts over the cap: receipt states the cap", res.rejections[0]?.evidence?.max === 40, JSON.stringify(res.rejections[0]?.evidence));
}

{
  const { doc } = infraDoc();
  // isolate the hosts link: the product node lets go of the build node first,
  // or op/node-realized (checked before hosts) speaks for it
  applyOps(doc, [{ op: "upsert_node", node: node("share-costs", { layer: "product", realizes: [] }) }]);
  const blocked = applyOps(doc, [{ op: "remove_node", id: "group-store" }, { op: "remove_node", id: "groups" }]);
  check("hosted build node: only the unhosted child removed", blocked.applied === 1 && blocked.rejections.length === 1, JSON.stringify(blocked));
  const receipt = blocked.rejections[0];
  check("hosted build node: code is op/node-hosted", receipt?.code === "op/node-hosted", JSON.stringify(receipt));
  check(
    "hosted build node: receipt names the infra node",
    JSON.stringify(receipt?.evidence?.hostedBy) === '["main-database"]',
    JSON.stringify(receipt?.evidence),
  );
  check("hosted build node: still in the doc", doc.nodes.some((n) => n.id === "groups"));
  const freed = applyOps(doc, [
    { op: "upsert_node", node: node("main-database", { layer: "infra", hosts: [] }) },
    { op: "remove_node", id: "groups" },
  ]);
  check("hosted build node: removable once the infra node drops it", freed.applied === 2 && freed.rejections.length === 0, JSON.stringify(freed));
  check("hosted build node: gone from the doc", !doc.nodes.some((n) => n.id === "groups"));
}

{
  // flipping a still-hosted build node onto the infra layer would dangle the link
  const { doc } = infraDoc();
  applyOps(doc, [{ op: "upsert_node", node: node("share-costs", { layer: "product", realizes: [] }) }]);
  const res = applyOps(doc, [{ op: "upsert_node", node: node("groups", { layer: "infra" }) }]);
  checkReceipt("hosted build node flipped to infra", res, "op/node-hosted");
}

{
  const { doc } = infraDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("backup-store", { layer: "infra", parentId: "groups" }) },
  ]);
  checkReceipt("infra child under a build parent", res, "op/cross-layer-parent");
}

{
  const { doc } = infraDoc();
  const res = applyOps(doc, [
    { op: "upsert_edge", edge: { id: "main-database--groups", source: "main-database", target: "groups", kind: "depends" } },
  ]);
  checkReceipt("edge from infra to build", res, "op/cross-layer-edge");
}

{
  // the infra layer has no root requirement: several top-level bubbles are fine
  const { doc } = infraDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("where-it-runs", { layer: "infra", kind: "host", hosts: ["group-store"] }) },
    { op: "upsert_node", node: node("build-pipeline", { layer: "infra", kind: "ci" }) },
  ]);
  check("infra: two more top-level infra bubbles accepted", res.applied === 2 && res.rejections.length === 0, JSON.stringify(res));
  check(
    "infra: three top-level infra bubbles coexist",
    doc.nodes.filter((n) => layerOf(n) === "infra" && n.parentId === null).length === 3,
  );
}

// --- the correctness layer: what proves it works, and the verifies link -----

check("correctness: LAYERS names four layers", LAYERS.join(",") === "product,build,infra,correctness", LAYERS.join(","));
check("correctness: emptyGraph carries an empty verification array", JSON.stringify(emptyGraph().reality.verification) === "[]");

/** the layered doc plus `protocol-checks`, a correctness bubble attesting `groups` */
function correctnessDoc() {
  const { doc } = layeredDoc();
  const res = applyOps(doc, [
    {
      op: "upsert_node",
      node: node("protocol-checks", {
        layer: "correctness",
        kind: "test",
        codeRefs: ["packages/shared/scripts/smoke.mjs"],
        verifies: ["groups"],
      }),
    },
  ]);
  return { doc, res };
}

{
  const { doc, res } = correctnessDoc();
  check("correctness: correctness node with verifies accepted", res.applied === 1 && res.rejections.length === 0, JSON.stringify(res));
  const verifier = doc.nodes.find((n) => n.id === "protocol-checks");
  check(
    "correctness: node stores layer, kind and verifies",
    verifier?.layer === "correctness" && verifier?.kind === "test" && JSON.stringify(verifier?.verifies) === '["groups"]',
    JSON.stringify(verifier),
  );
  check("correctness: layerOf reads the fourth layer", layerOf(verifier) === "correctness");
  check(
    "correctness: verifiedOf lists the build nodes it attests",
    verifiedOf(doc, "protocol-checks").map((n) => n.id).join(",") === "groups",
    JSON.stringify(verifiedOf(doc, "protocol-checks").map((n) => n.id)),
  );
  check(
    "correctness: verifiersOf on the named build node",
    verifiersOf(doc, "groups").map((n) => n.id).join(",") === "protocol-checks",
    JSON.stringify(verifiersOf(doc, "groups").map((n) => n.id)),
  );
  check(
    "correctness: verifiersOf inherits through the ancestor rule",
    verifiersOf(doc, "group-store").map((n) => n.id).join(",") === "protocol-checks",
    JSON.stringify(verifiersOf(doc, "group-store").map((n) => n.id)),
  );
  check("correctness: verifiersOf of a correctness node is empty", verifiersOf(doc, "protocol-checks").length === 0);
  check("correctness: verifiedOf of a build node is empty", verifiedOf(doc, "groups").length === 0);
  check("correctness: productRootOf ignores the correctness layer", productRootOf(doc)?.id === "share-costs");
  check(
    "correctness: verifies sticks across an upsert that omits it",
    (() => {
      applyOps(doc, [{ op: "upsert_node", node: node("protocol-checks", { status: "running" }) }]);
      const same = doc.nodes.find((n) => n.id === "protocol-checks");
      return same?.layer === "correctness" && JSON.stringify(same?.verifies) === '["groups"]';
    })(),
    JSON.stringify(doc.nodes.find((n) => n.id === "protocol-checks")),
  );
}

{
  const { doc } = layeredDoc();
  const res = applyOps(doc, [{ op: "upsert_node", node: node("worker", { verifies: ["groups"] }) }]);
  checkReceipt("verifies on a build node", res, "op/bad-verifies");
}

{
  const { doc } = layeredDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("protocol-checks", { layer: "correctness", verifies: ["share-costs"] }) },
  ]);
  checkReceipt("verifies naming a product node", res, "op/bad-verifies");
  check(
    "verifies naming a product node: receipt names the layer it found",
    res.rejections[0]?.evidence?.targetLayer === "product",
    JSON.stringify(res.rejections[0]?.evidence),
  );
}

{
  const { doc } = layeredDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("protocol-checks", { layer: "correctness", verifies: ["ghost"] }) },
  ]);
  checkReceipt("verifies naming an unknown id", res, "op/bad-verifies");
}

{
  const { doc } = layeredDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("protocol-checks", { layer: "correctness", verifies: ["groups", "groups"] }) },
  ]);
  checkReceipt("verifies listing an id twice", res, "op/bad-verifies");
}

{
  const { doc } = layeredDoc();
  const many = Array.from({ length: 41 }, (_, i) => `part-${i}`);
  applyOps(doc, many.map((id) => ({ op: "upsert_node", node: node(id) })));
  const res = applyOps(doc, [{ op: "upsert_node", node: node("protocol-checks", { layer: "correctness", verifies: many }) }]);
  checkReceipt("verifies over the cap of 40", res, "op/bad-verifies");
  check("verifies over the cap: receipt states the cap", res.rejections[0]?.evidence?.max === 40, JSON.stringify(res.rejections[0]?.evidence));
}

{
  // Clean cutover on the wire: the layer used to be called "verify", and that
  // name is not a layer any more. An op still sending it is treated like any
  // unknown value — the bubble is a build bubble — so the `verifies` only a
  // correctness bubble may carry comes back rejected.
  const { doc } = layeredDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("protocol-checks", { layer: "verify", verifies: ["groups"] }) },
  ]);
  checkReceipt('the retired "verify" layer name with verifies', res, "op/bad-verifies");
  check(
    'the retired "verify" layer name: receipt says the node landed on build',
    res.rejections[0]?.evidence?.layer === "build",
    JSON.stringify(res.rejections[0]?.evidence),
  );
  const plain = applyOps(doc, [{ op: "upsert_node", node: node("stale-checks", { layer: "verify" }) }]);
  check(
    'the retired "verify" layer name never lands on the correctness layer',
    plain.applied === 1 && layerOf(doc.nodes.find((n) => n.id === "stale-checks")) === "build",
    JSON.stringify(doc.nodes.find((n) => n.id === "stale-checks")),
  );
}

{
  const { doc } = correctnessDoc();
  // isolate the verifies link: the product node lets go of the build node
  // first, or op/node-realized (checked before verifies) speaks for it
  applyOps(doc, [{ op: "upsert_node", node: node("share-costs", { layer: "product", realizes: [] }) }]);
  const blocked = applyOps(doc, [{ op: "remove_node", id: "group-store" }, { op: "remove_node", id: "groups" }]);
  check("verified build node: only the unverified child removed", blocked.applied === 1 && blocked.rejections.length === 1, JSON.stringify(blocked));
  const receipt = blocked.rejections[0];
  check("verified build node: code is op/node-verified", receipt?.code === "op/node-verified", JSON.stringify(receipt));
  check(
    "verified build node: receipt names the correctness node",
    JSON.stringify(receipt?.evidence?.verifiedBy) === '["protocol-checks"]',
    JSON.stringify(receipt?.evidence),
  );
  check("verified build node: still in the doc", doc.nodes.some((n) => n.id === "groups"));
  const freed = applyOps(doc, [
    { op: "upsert_node", node: node("protocol-checks", { layer: "correctness", verifies: [] }) },
    { op: "remove_node", id: "groups" },
  ]);
  check("verified build node: removable once the correctness node drops it", freed.applied === 2 && freed.rejections.length === 0, JSON.stringify(freed));
  check("verified build node: gone from the doc", !doc.nodes.some((n) => n.id === "groups"));
}

{
  // flipping a still-verified build node onto the correctness layer would dangle the link
  const { doc } = correctnessDoc();
  applyOps(doc, [{ op: "upsert_node", node: node("share-costs", { layer: "product", realizes: [] }) }]);
  const res = applyOps(doc, [{ op: "upsert_node", node: node("groups", { layer: "correctness" }) }]);
  checkReceipt("verified build node flipped to correctness", res, "op/node-verified");
}

{
  const { doc } = correctnessDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("unit-checks", { layer: "correctness", parentId: "groups" }) },
  ]);
  checkReceipt("correctness child under a build parent", res, "op/cross-layer-parent");
}

{
  const { doc } = correctnessDoc();
  const res = applyOps(doc, [
    { op: "upsert_edge", edge: { id: "protocol-checks--groups", source: "protocol-checks", target: "groups", kind: "depends" } },
  ]);
  checkReceipt("edge from correctness to build", res, "op/cross-layer-edge");
}

{
  // like infra, the correctness layer has no root requirement
  const { doc } = correctnessDoc();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("push-checks", { layer: "correctness", kind: "check", verifies: ["group-store"] }) },
    { op: "upsert_node", node: node("release-review", { layer: "correctness", kind: "review" }) },
  ]);
  check("correctness: two more top-level correctness bubbles accepted", res.applied === 2 && res.rejections.length === 0, JSON.stringify(res));
  check(
    "correctness: three top-level correctness bubbles coexist",
    doc.nodes.filter((n) => layerOf(n) === "correctness" && n.parentId === null).length === 3,
  );
}

// --- verification status: the authored link, then the mechanical cover rule --

{
  const { doc } = correctnessDoc();
  check("status: an intent verifier verifies the named build node", verificationOf(doc, "groups") === "verified");
  check("status: and its children through the ancestor rule", verificationOf(doc, "group-store") === "verified");
  check("status: a build node nothing attests is unverified", verificationOf(doc, "share-costs") === "unverified");
}

/**
 * `parts` (codeRefs `refs`) with child `part-store` (codeRefs `childRefs`), plus
 * ONE extracted verification covering `covers` and no correctness bubble anywhere —
 * the mechanical half of `verificationOf` on its own.
 */
function coveredDoc({ covers, refs = [], childRefs = [] }) {
  const doc = emptyGraph();
  applyOps(doc, [
    { op: "upsert_node", node: node("parts", refs.length > 0 ? { codeRefs: refs } : {}) },
    {
      op: "upsert_node",
      node: node("part-store", { parentId: "parts", ...(childRefs.length > 0 ? { codeRefs: childRefs } : {}) }),
    },
  ]);
  doc.reality.verification.push({
    id: "v:tests",
    label: "Tests in packages/app (3 files)",
    kind: "test",
    evidence: ["packages/app/src/store.test.ts"],
    hint: "3 test files under packages/app",
    covers,
  });
  return doc;
}

{
  const wide = coveredDoc({ covers: ["packages/app"], refs: ["packages/app/src/store.ts"] });
  check("cover: a cover above the codeRef verifies it", verificationOf(wide, "parts") === "verified");
  const narrow = coveredDoc({ covers: ["packages/app/src/store.ts"], refs: ["packages/app"] });
  check("cover: a cover below the codeRef verifies it", verificationOf(narrow, "parts") === "verified");
  const exact = coveredDoc({ covers: ["packages/app/src/store.ts"], refs: ["packages/app/src/store.ts"] });
  check("cover: an exact match verifies it", verificationOf(exact, "parts") === "verified");
  const symbol = coveredDoc({ covers: ["packages/app/src/store.ts"], refs: ["packages/app/src/store.ts#Store"] });
  check("cover: a symbol ref stands for its file", verificationOf(symbol, "parts") === "verified");
  const inherited = coveredDoc({ covers: ["packages/app/src"], refs: ["packages/app"] });
  check("cover: a child inherits its ancestor's covered codeRefs", verificationOf(inherited, "part-store") === "verified");
  const elsewhere = coveredDoc({ covers: ["packages/other"], refs: ["packages/app"] });
  check("cover: a cover somewhere else verifies nothing", verificationOf(elsewhere, "parts") === "unverified");
  const sibling = coveredDoc({ covers: ["packages/app-extra"], refs: ["packages/app"] });
  check("cover: a sibling path sharing a prefix is not covered", verificationOf(sibling, "parts") === "unverified");
  const unclaimed = coveredDoc({ covers: ["packages/app"] });
  check("cover: a bubble owning no code is unverified", verificationOf(unclaimed, "parts") === "unverified");
  check("cover: an unknown id is unverified", verificationOf(unclaimed, "ghost") === "unverified");
}

{
  const doc = emptyGraph();
  applyOps(doc, [
    { op: "upsert_node", node: node("alpha", { codeRefs: ["packages/alpha"] }) },
    { op: "upsert_node", node: node("beta", { codeRefs: ["packages/beta"] }) },
    { op: "upsert_node", node: node("share-costs", { layer: "product", realizes: ["alpha", "beta"] }) },
    { op: "upsert_node", node: node("no-parts", { layer: "product", parentId: "share-costs" }) },
  ]);
  check("rollup: a capability with no realizers reads as none", capabilityVerification(doc, "no-parts") === "none");
  check("rollup: no realizer verified reads as unverified", capabilityVerification(doc, "share-costs") === "unverified");
  applyOps(doc, [
    { op: "upsert_node", node: node("alpha-checks", { layer: "correctness", kind: "test", verifies: ["alpha"] }) },
  ]);
  check("rollup: one of two realizers verified reads as partial", capabilityVerification(doc, "share-costs") === "partial");
  applyOps(doc, [
    { op: "upsert_node", node: node("beta-checks", { layer: "correctness", kind: "smoke", verifies: ["beta"] }) },
  ]);
  check("rollup: every realizer verified reads as verified", capabilityVerification(doc, "share-costs") === "verified");
  check("rollup: a build node is not a capability", capabilityVerification(doc, "alpha") === "none");
}

// --- link gaps: connection is the default -----------------------------------

const gaps = (doc, id) => JSON.stringify(linkGapsOf(doc, id));

check("gaps: LINKED_PHASES names the phases a bubble is asked to be wired at", LINKED_PHASES.join(",") === "component,building,built", LINKED_PHASES.join(","));

{
  const { doc } = layeredDoc();
  applyOps(doc, [{ op: "upsert_node", node: node("split-fairly", { parentId: "share-costs", layer: "product" }) }]);
  check("gaps: an idea-phase capability may stand alone", gaps(doc, "split-fairly") === "[]", gaps(doc, "split-fairly"));
  applyOps(doc, [{ op: "set_phase", id: "split-fairly", phase: "component" }]);
  check("gaps: a component capability nothing realizes is unrealized", gaps(doc, "split-fairly") === '["unrealized"]', gaps(doc, "split-fairly"));
  applyOps(doc, [
    { op: "upsert_node", node: node("split-fairly", { parentId: "share-costs", layer: "product", phase: "component", realizes: ["groups"] }) },
  ]);
  check("gaps: naming a realizer closes the gap", gaps(doc, "split-fairly") === "[]", gaps(doc, "split-fairly"));
}

{
  const doc = emptyGraph();
  applyOps(doc, [
    { op: "upsert_node", node: node("groups") },
    { op: "upsert_node", node: node("share-costs", { layer: "product", phase: "component" }) },
  ]);
  check("gaps: the product root is never asked what realizes it", gaps(doc, "share-costs") === "[]", gaps(doc, "share-costs"));
  check("gaps: an unknown id has no gaps", gaps(doc, "ghost") === "[]");
}

{
  const { doc } = layeredDoc();
  applyOps(doc, [{ op: "upsert_node", node: node("settle-up", { phase: "component" }) }]);
  check("gaps: with only the root above it, no part is unserved", gaps(doc, "settle-up") === "[]", gaps(doc, "settle-up"));
  applyOps(doc, [
    { op: "upsert_node", node: node("split-fairly", { parentId: "share-costs", layer: "product", phase: "component", realizes: ["groups"] }) },
  ]);
  check("gaps: a part no capability names is unserved", gaps(doc, "settle-up") === '["unserved"]', gaps(doc, "settle-up"));
  applyOps(doc, [{ op: "set_phase", id: "groups", phase: "component" }]);
  check("gaps: the part a capability names is clean", gaps(doc, "groups") === "[]", gaps(doc, "groups"));
}

{
  const { doc } = layeredDoc();
  applyOps(doc, [{ op: "set_phase", id: "groups", phase: "component" }]);
  check("gaps: with no infra in the graph nothing is unhosted", gaps(doc, "groups") === "[]", gaps(doc, "groups"));
  applyOps(doc, [
    { op: "upsert_node", node: node("build-pipeline", { layer: "infra", kind: "ci", phase: "component" }) },
  ]);
  check("gaps: once infra exists an unplaced part is unhosted", gaps(doc, "groups") === '["unhosted"]', gaps(doc, "groups"));
  check("gaps: infrastructure running nothing hosts-nothing", gaps(doc, "build-pipeline") === '["hosts-nothing"]', gaps(doc, "build-pipeline"));
}

{
  const { doc } = infraDoc();
  applyOps(doc, [
    { op: "set_phase", id: "main-database", phase: "component" },
    { op: "set_phase", id: "group-store", phase: "built" },
    {
      op: "upsert_node",
      node: node("protocol-checks", { layer: "correctness", kind: "test", phase: "component", verifies: ["groups"] }),
    },
  ]);
  check("gaps: a child of a served, hosted and attested parent inherits all three", gaps(doc, "group-store") === "[]", gaps(doc, "group-store"));
  check("gaps: infrastructure that runs a part is connected", gaps(doc, "main-database") === "[]", gaps(doc, "main-database"));
  check("gaps: a check that attests a part is connected", gaps(doc, "protocol-checks") === "[]", gaps(doc, "protocol-checks"));
}

{
  const covered = coveredDoc({ covers: ["packages/app"], refs: ["packages/app/src/store.ts"] });
  applyOps(covered, [{ op: "set_phase", id: "parts", phase: "built" }]);
  check("gaps: a built part covered mechanically is attested", gaps(covered, "parts") === "[]", gaps(covered, "parts"));
  const bare = coveredDoc({ covers: ["packages/other"], refs: ["packages/app"] });
  applyOps(bare, [{ op: "set_phase", id: "parts", phase: "built" }]);
  check("gaps: a finished part nothing attests is unattested", gaps(bare, "parts") === '["unattested"]', gaps(bare, "parts"));
  applyOps(bare, [{ op: "set_phase", id: "parts", phase: "building" }]);
  check("gaps: a part still being built is not yet asked for a check", gaps(bare, "parts") === "[]", gaps(bare, "parts"));
  applyOps(bare, [{ op: "set_phase", id: "parts", phase: "failed" }]);
  check("gaps: a dead end owes no links", gaps(bare, "parts") === "[]", gaps(bare, "parts"));
}

{
  const doc = emptyGraph();
  applyOps(doc, [
    { op: "upsert_node", node: node("protocol-checks", { layer: "correctness", kind: "test", phase: "component" }) },
    { op: "upsert_node", node: node("build-pipeline", { layer: "infra", kind: "ci", phase: "component" }) },
  ]);
  check("gaps: with no build layer a check attests nothing missing", gaps(doc, "protocol-checks") === "[]", gaps(doc, "protocol-checks"));
  check("gaps: with no build layer infra hosts nothing missing", gaps(doc, "build-pipeline") === "[]", gaps(doc, "build-pipeline"));
  applyOps(doc, [{ op: "upsert_node", node: node("groups") }]);
  check("gaps: once parts exist a check naming none attests-nothing", gaps(doc, "protocol-checks") === '["attests-nothing"]', gaps(doc, "protocol-checks"));
  check("gaps: once parts exist infra naming none hosts-nothing", gaps(doc, "build-pipeline") === '["hosts-nothing"]', gaps(doc, "build-pipeline"));
}

{
  const { doc } = layeredDoc();
  applyOps(doc, [
    { op: "upsert_node", node: node("split-fairly", { parentId: "share-costs", layer: "product", phase: "component", realizes: ["groups"] }) },
    { op: "upsert_node", node: node("main-database", { layer: "infra", kind: "database", hosts: ["groups"] }) },
    { op: "upsert_node", node: node("settle-up", { phase: "built" }) },
  ]);
  check(
    "gaps: a finished part connected to nothing lists them in union order",
    gaps(doc, "settle-up") === '["unserved","unhosted","unattested"]',
    gaps(doc, "settle-up"),
  );
}

// --- canonical form + delta for the correctness layer -----------------------

{
  const at = "2026-09-03T00:00:00.000Z";
  const { doc } = correctnessDoc();
  applyOps(doc, [
    { op: "upsert_node", node: node("protocol-checks", { layer: "correctness", verifies: ["group-store", "groups"] }) },
  ]);
  const before = snapshotGraph(doc, at);
  const canonicalCorrectness = before.nodes.find((n) => n.id === "protocol-checks");
  check(
    "canonical: correctness node keeps its layer and sorts verifies",
    canonicalCorrectness?.layer === "correctness" && JSON.stringify(canonicalCorrectness?.verifies) === '["group-store","groups"]',
    JSON.stringify(canonicalCorrectness),
  );
  check(
    "canonical: verifies order does not change the snapshot",
    (() => {
      const reordered = emptyGraph();
      reordered.nodes.push({ ...node("protocol-checks"), layer: "correctness", verifies: ["groups", "group-store"] });
      const sorted = emptyGraph();
      sorted.nodes.push({ ...node("protocol-checks"), layer: "correctness", verifies: ["group-store", "groups"] });
      return canonicalJson(snapshotGraph(reordered, at)) === canonicalJson(snapshotGraph(sorted, at));
    })(),
  );

  applyOps(doc, [{ op: "upsert_node", node: node("protocol-checks", { layer: "correctness", verifies: ["groups"] }) }]);
  const delta = diffSnapshots(before, snapshotGraph(doc, at));
  const changed = delta.nodes.changed.find((c) => c.before.id === "protocol-checks");
  check(
    "delta: a verifies change is reported as changed",
    delta.nodes.changed.length === 1 &&
      JSON.stringify(changed?.before.verifies) === '["group-store","groups"]' &&
      JSON.stringify(changed?.after.verifies) === '["groups"]',
    JSON.stringify(delta.nodes),
  );
}

// --- codeRefs: path prefixes and "<file>#<Name>" symbol refs ----------------

{
  const doc = emptyGraph();
  const res = applyOps(doc, [
    { op: "upsert_node", node: node("room", { codeRefs: ["packages/bridge/src/server/room.ts#Room", "packages/bridge"] }) },
  ]);
  check("refs: a symbol ref is accepted", res.applied === 1 && res.rejections.length === 0, JSON.stringify(res));
  check(
    "refs: symbol ref round-trips into the doc",
    JSON.stringify(doc.nodes[0]?.codeRefs) === '["packages/bridge/src/server/room.ts#Room","packages/bridge"]',
    JSON.stringify(doc.nodes[0]),
  );
  check(
    "refs: symbolRefOf splits a symbol ref",
    JSON.stringify(symbolRefOf("packages/bridge/src/server/room.ts#Room")) ===
      '{"path":"packages/bridge/src/server/room.ts","name":"Room"}',
    JSON.stringify(symbolRefOf("packages/bridge/src/server/room.ts#Room")),
  );
  check("refs: symbolRefOf of a plain path is null", symbolRefOf("packages/bridge") === null);
  for (const ref of ["a#b#c", "#Name", "file.ts#"]) {
    check(`refs: symbolRefOf rejects ${ref}`, symbolRefOf(ref) === null, JSON.stringify(symbolRefOf(ref)));
    const bad = emptyGraph();
    const res = applyOps(bad, [{ op: "upsert_node", node: node("mystery", { codeRefs: [ref] }) }]);
    checkReceipt(`malformed symbol ref ${ref}`, res, "op/bad-coderefs");
  }
}

// --- canonical form + delta for the infra layer -----------------------------

{
  const at = "2026-09-03T00:00:00.000Z";
  const { doc } = infraDoc();
  applyOps(doc, [
    { op: "upsert_node", node: node("main-database", { layer: "infra", hosts: ["group-store", "groups"] }) },
  ]);
  const before = snapshotGraph(doc, at);
  const canonicalInfra = before.nodes.find((n) => n.id === "main-database");
  check(
    "canonical: infra node keeps its layer and sorts hosts",
    canonicalInfra?.layer === "infra" && JSON.stringify(canonicalInfra?.hosts) === '["group-store","groups"]',
    JSON.stringify(canonicalInfra),
  );
  check(
    "canonical: hosts order does not change the snapshot",
    (() => {
      const reordered = emptyGraph();
      reordered.nodes.push({ ...node("main-database"), layer: "infra", hosts: ["groups", "group-store"] });
      const sorted = emptyGraph();
      sorted.nodes.push({ ...node("main-database"), layer: "infra", hosts: ["group-store", "groups"] });
      return canonicalJson(snapshotGraph(reordered, at)) === canonicalJson(snapshotGraph(sorted, at));
    })(),
  );

  applyOps(doc, [{ op: "upsert_node", node: node("main-database", { layer: "infra", hosts: ["groups"] }) }]);
  const delta = diffSnapshots(before, snapshotGraph(doc, at));
  const changed = delta.nodes.changed.find((c) => c.before.id === "main-database");
  check(
    "delta: a hosts change is reported as changed",
    delta.nodes.changed.length === 1 &&
      JSON.stringify(changed?.before.hosts) === '["group-store","groups"]' &&
      JSON.stringify(changed?.after.hosts) === '["groups"]',
    JSON.stringify(delta.nodes),
  );
}

// --- the end-of-turn card: what `next` accepts and what it refuses ---------

{
  const good = parseNext({
    summary: "The notebook saves recordings, and the export kit is the last piece left.",
    choices: [
      { label: "Build the export kit", say: "Build the export kit next." },
      { label: "Leave it for later", say: "Leave the export kit for later and tidy what is built." },
    ],
    question: "One file per recording, or one file per trip?",
  });
  check(
    "next: a well-formed card parses whole",
    typeof good !== "string" && good.choices.length === 2 && good.choices[1]?.say.startsWith("Leave the export kit") &&
      good.question === "One file per recording, or one file per trip?",
    JSON.stringify(good),
  );
  const finished = parseNext({ summary: "Everything asked for is built and attested.", choices: [] });
  check(
    "next: no choices and no question is the finished card",
    typeof finished !== "string" && finished.choices.length === 0 && finished.question === null,
    JSON.stringify(finished),
  );
  const blankQuestion = parseNext({ summary: "Where things stand.", choices: [], question: "   " });
  check(
    "next: a blank question reads as no question",
    typeof blankQuestion !== "string" && blankQuestion.question === null,
    JSON.stringify(blankQuestion),
  );
  const refusals = {
    "five choices": { summary: "s", choices: Array.from({ length: 5 }, (_, i) => ({ label: `c${i}`, say: `say ${i}` })) },
    "a 60-char label": { summary: "s", choices: [{ label: "x".repeat(60), say: "go" }] },
    "a summary over 200 chars": { summary: "x".repeat(201), choices: [] },
    "an empty summary": { summary: "   ", choices: [] },
    "a choice with no say": { summary: "s", choices: [{ label: "go" }] },
    "choices that are not a list": { summary: "s", choices: "keep going" },
    "a question that is not text": { summary: "s", choices: [], question: 7 },
  };
  for (const [label, raw] of Object.entries(refusals)) {
    const result = parseNext(raw);
    check(`next: ${label} is refused with a reason`, typeof result === "string" && result.length > 0, JSON.stringify(result));
  }
}

console.log(`\n${results.join("\n")}\n`);
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
