#!/usr/bin/env node
/**
 * Shared-contract smoke test for `applyOps` (packages/shared/src/index.ts).
 * Pure in-process checks, deterministic, sub-second: the `kind` round-trip,
 * one structured repair receipt per major rejection class (#5 shape), and
 * unknown-`kind` degradation. Mirrors packages/bridge/scripts/smoke.mjs.
 */

import { applyOps, emptyGraph } from "../src/index.ts";

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

console.log(`\n${results.join("\n")}\n`);
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
