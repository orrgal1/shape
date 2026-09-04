#!/usr/bin/env node
/**
 * Drift attribution smoke test. Pure computeDrift — no bridge, no sockets.
 *
 * Fixture: scripts/fixtures/playground-graph.json, a verbatim copy of
 * shape-playground's .shape/graph.json at rev 15 (17 bubbles, 18 intent edges,
 * 9 reality packages, 17 reality edges). Its stored `drift` is what the old
 * per-descendant rule produced, so it doubles as the "before" number.
 *
 * Four sections: the real playground graph, undeclared dependencies, phantom
 * dependencies, and refs naming a part inside a file (29 checks in total).
 *
 * Usage (from packages/bridge): node scripts/smoke-drift.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { computeDrift } from "../src/server/drift.ts";

const here = dirname(fileURLToPath(import.meta.url));
const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

const noteCount = (drift) => Object.values(drift).reduce((n, list) => n + list.length, 0);

// ---------------------------------------------------------------------------
// 1. The real playground graph
// ---------------------------------------------------------------------------

const graph = JSON.parse(readFileSync(join(here, "fixtures", "playground-graph.json"), "utf8"));
const { nodes, edges, reality } = graph;
const byId = new Map(nodes.map((n) => [n.id, n]));
const label = (id) => byId.get(id)?.label ?? id;

const before = graph.drift ?? {};
const drift = computeDrift({ nodes, edges }, reality);

console.log(
  `playground rev ${graph.rev}: ${nodes.length} nodes, ${edges.length} edges, ` +
    `${reality.nodes.length} packages, ${reality.edges.length} reality edges`,
);
console.log(
  `notes before (stored, old rule): ${noteCount(before)} across ${Object.keys(before).length} node(s)`,
);
console.log(
  `notes after  (this rule):        ${noteCount(drift)} across ${Object.keys(drift).length} node(s)`,
);
for (const [id, list] of Object.entries(drift)) {
  for (const text of list) console.log(`  ${id} (${label(id)}): ${text}`);
}

// No child bubble carries a note: attribution lands on the owning top-level bubble.
const childrenWithNotes = Object.keys(drift).filter((id) => (byId.get(id)?.parentId ?? null) !== null);
check(
  "no child node carries a drift note",
  childrenWithNotes.length === 0,
  childrenWithNotes.join(", "),
);

// `the service` declares config/domain/notify/queue/store, so none of them drift.
const apiNotes = drift["ledgerly-api"] ?? [];
const declaredFromApi = ["config", "domain", "notify", "queue", "store"];
for (const pkg of declaredFromApi) {
  const hit = apiNotes.filter((t) => t.includes(`@ledgerly/${pkg}`));
  check(`the service has no note for @ledgerly/${pkg}`, hit.length === 0, hit.join(" | "));
}
check(
  "api-no-auth (child of the service) is clean",
  drift["api-no-auth"] === undefined,
  JSON.stringify(drift["api-no-auth"] ?? []),
);
for (const child of ["domain-splits", "domain-settlement", "store-safe-write", "store-scratch"]) {
  check(`${child} is clean`, drift[child] === undefined, JSON.stringify(drift[child] ?? []));
}

// Independent recount of which reality edges genuinely lack a declared counterpart:
// hierarchy-transparent coverage, direction preserved.
const ownPkgs = new Map();
const dirsLongestFirst = [...reality.nodes]
  .map((n) => ({ id: n.id, dir: n.dir.replace(/^\.\//, "").replace(/\/+$/, "") }))
  .sort((a, b) => b.dir.length - a.dir.length);
for (const n of nodes) {
  const pkgs = new Set();
  for (const raw of n.codeRefs ?? []) {
    const ref = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    const hit = dirsLongestFirst.find((c) => ref === c.dir || ref.startsWith(c.dir + "/"));
    if (hit) pkgs.add(hit.id);
  }
  if (pkgs.size > 0) ownPkgs.set(n.id, pkgs);
}
const covers = new Map(nodes.map((n) => [n.id, new Set()]));
for (const [id, pkgs] of ownPkgs) {
  for (let cur = id; cur !== null; cur = byId.get(cur)?.parentId ?? null) {
    for (const p of pkgs) covers.get(cur).add(p);
  }
}
const anyCovers = (pkg) => nodes.some((n) => covers.get(n.id).has(pkg));
const unsatisfied = reality.edges.filter(
  (re) =>
    anyCovers(re.source) &&
    anyCovers(re.target) &&
    !nodes.some((n) => ownPkgs.get(n.id)?.has(re.source) && ownPkgs.get(n.id)?.has(re.target)) &&
    !edges.some((e) => covers.get(e.source)?.has(re.source) && covers.get(e.target)?.has(re.target)),
);
console.log(
  `reality edges with no declared counterpart: ${unsatisfied.length}` +
    (unsatisfied.length === 0 ? "" : ` (${unsatisfied.map((e) => `${e.source}->${e.target}`).join(", ")})`),
);
check(
  "note count equals the number of genuinely unsatisfied reality edges",
  noteCount(drift) === unsatisfied.length,
  `${noteCount(drift)} notes vs ${unsatisfied.length} unsatisfied`,
);
check(
  "attribution shrank the note set",
  noteCount(drift) < noteCount(before),
  `${noteCount(before)} -> ${noteCount(drift)}`,
);

// ---------------------------------------------------------------------------
// 2. Synthetic: one unsatisfied reality edge -> exactly one note, on the top bubble
// ---------------------------------------------------------------------------

const syntheticReality = {
  nodes: [
    { id: "r:@x/api", label: "@x/api", dir: "apps/api", files: 3 },
    { id: "r:@x/db", label: "@x/db", dir: "packages/db", files: 2 },
  ],
  edges: [{ id: "r:@x/api--r:@x/db", source: "r:@x/api", target: "r:@x/db" }],
  extractedAt: null,
  head: null,
};
const node = (id, parentId, phase, codeRefs) => ({
  id,
  parentId,
  label: id,
  summary: `${id} does a thing`,
  phase,
  codeRefs,
});
const undeclared = {
  nodes: [
    node("the-service", null, "built", ["apps/api"]),
    node("inner-bit", "the-service", "built", ["apps/api/src/server.ts"]),
    node("deeper-bit", "inner-bit", "built", ["apps/api/src/router.ts"]),
    node("the-records", null, "built", ["packages/db"]),
    node("records-child", "the-records", "built", ["packages/db/src/rows.ts"]),
  ],
  edges: [],
};
const d1 = computeDrift(undeclared, syntheticReality);
check("synthetic undeclared: exactly one note", noteCount(d1) === 1, JSON.stringify(d1));
check(
  "synthetic undeclared: note sits on the top-level bubble owning the source package",
  Object.keys(d1).length === 1 && Object.keys(d1)[0] === "the-service",
  Object.keys(d1).join(", "),
);
check(
  "synthetic undeclared: note names the imported package and its owning bubble",
  (d1["the-service"] ?? [""])[0] === 'code imports @x/db (node "the-records") but no edge is declared',
  (d1["the-service"] ?? [""])[0],
);

// A declared edge between descendants satisfies the package-level import.
const d2 = computeDrift(
  { nodes: undeclared.nodes, edges: [{ id: "e1", kind: "depends", source: "deeper-bit", target: "records-child" }] },
  syntheticReality,
);
check("descendant-to-descendant edge satisfies the reality edge", noteCount(d2) === 0, JSON.stringify(d2));

// Direction matters: a Q->P edge does not answer a P->Q import.
const d3 = computeDrift(
  { nodes: undeclared.nodes, edges: [{ id: "e1", kind: "depends", source: "the-records", target: "the-service" }] },
  syntheticReality,
);
check(
  "backwards edge does not satisfy the import (still one note on the source owner)",
  noteCount(d3) === 1 && d3["the-service"] !== undefined,
  JSON.stringify(d3),
);

// One bubble owning both packages has nothing to declare.
const d4 = computeDrift(
  { nodes: [node("the-whole-thing", null, "built", ["apps/api", "packages/db"])], edges: [] },
  syntheticReality,
);
check("one bubble whose own refs straddle both packages: no note", noteCount(d4) === 0, JSON.stringify(d4));

// ---------------------------------------------------------------------------
// 3. Synthetic: the reverse rule still fires
// ---------------------------------------------------------------------------

const noRealityEdge = { ...syntheticReality, edges: [] };
const d5 = computeDrift(
  {
    nodes: undeclared.nodes,
    edges: [{ id: "e1", kind: "depends", source: "the-service", target: "the-records" }],
  },
  noRealityEdge,
);
check(
  "reverse rule: declared depends with no reality edge yields one note on the source",
  noteCount(d5) === 1 && (d5["the-service"] ?? [""])[0] ===
    'declared dependency on "the-records" has no corresponding import in code',
  JSON.stringify(d5),
);
const d6 = computeDrift(
  {
    nodes: undeclared.nodes,
    edges: [{ id: "e1", kind: "depends", source: "deeper-bit", target: "records-child" }],
  },
  noRealityEdge,
);
check(
  "reverse rule is hierarchy-transparent: descendant ends are judged by their packages",
  noteCount(d6) === 1 && d6["deeper-bit"] !== undefined,
  JSON.stringify(d6),
);
const d7 = computeDrift(
  {
    nodes: undeclared.nodes,
    edges: [{ id: "e1", kind: "depends", source: "the-service", target: "the-records" }],
  },
  syntheticReality,
);
check("reverse rule stays quiet when the import exists", noteCount(d7) === 0, JSON.stringify(d7));
const d8 = computeDrift(
  {
    nodes: [node("the-service", null, "shaping", ["apps/api"]), node("the-records", null, "shaping", ["packages/db"])],
    edges: [{ id: "e1", kind: "depends", source: "the-service", target: "the-records" }],
  },
  noRealityEdge,
);
check("reverse rule stays quiet before building", noteCount(d8) === 0, JSON.stringify(d8));

// ---------------------------------------------------------------------------
// 4. Synthetic: a ref into a file whose part is gone
// ---------------------------------------------------------------------------

/** a reality layer that read exactly one file, and found these parts in it */
const withSymbols = (names) => ({
  ...syntheticReality,
  edges: [],
  symbols: names.map((name, i) => ({
    id: `s:apps/api/src/room.ts#${name}`,
    file: "apps/api/src/room.ts",
    name,
    kind: "function",
    exported: true,
    line: 10 + i,
    pkg: "r:@x/api",
  })),
  infra: [],
});

const symbolClaim = (ref, phase = "built") => ({
  nodes: [node("the-service", null, "built", ["apps/api"]), node("the-room", "the-service", phase, [ref])],
  edges: [],
});

const gone = computeDrift(symbolClaim("apps/api/src/room.ts#Room"), withSymbols(["openRoom"]));
check(
  "a ref naming a part the file no longer declares yields one note, on the claiming bubble",
  noteCount(gone) === 1 &&
    (gone["the-room"] ?? [""])[0] ===
      "names a part of the code that is no longer there: Room in apps/api/src/room.ts",
  JSON.stringify(gone),
);
const present = computeDrift(symbolClaim("apps/api/src/room.ts#Room"), withSymbols(["Room", "openRoom"]));
check(
  "the note disappears once the part is back in the file",
  noteCount(present) === 0,
  JSON.stringify(present),
);
const unread = computeDrift(symbolClaim("apps/api/src/other.ts#Room"), withSymbols(["openRoom"]));
check(
  "a file reality never read says nothing either way: no note",
  noteCount(unread) === 0,
  JSON.stringify(unread),
);
const early = computeDrift(symbolClaim("apps/api/src/room.ts#Room", "concept"), withSymbols(["openRoom"]));
check(
  "a part that is not built yet is not drift",
  noteCount(early) === 0,
  JSON.stringify(early),
);
const plainPath = computeDrift(symbolClaim("apps/api/src/room.ts"), withSymbols(["openRoom"]));
check(
  "a plain path ref is never judged against the parts of a file",
  noteCount(plainPath) === 0,
  JSON.stringify(plainPath),
);
const noSymbols = computeDrift(symbolClaim("apps/api/src/room.ts#Room"), { ...syntheticReality, edges: [] });
check(
  "a reality layer from a bridge that never read parts produces no symbol notes",
  noteCount(noSymbols) === 0,
  JSON.stringify(noSymbols),
);

// ---------------------------------------------------------------------------

console.log("");
for (const line of results) console.log(line);
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
