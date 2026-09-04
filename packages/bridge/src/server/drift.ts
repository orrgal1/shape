/**
 * Drift computation: the derived comparison between the agent-authored intent
 * layer and the reality layer extracted on the agent side.
 *
 * Pure: a graph document and a reality layer in, notes out. No filesystem, no
 * git — the server half never touches the target repo.
 */

import { normalizeIndexPath } from "../../../shared/src/fileindex.ts";
import { symbolRefOf } from "../../../shared/src/index.ts";
import type {
  DriftMap,
  GraphDoc,
  IntentNode,
  Phase,
  RealityLayer,
} from "../../../shared/src/index.ts";

/** Phases at which a declared dependency is expected to exist in code. */
const REALIZED_PHASES: Record<Phase, boolean> = {
  idea: false,
  concept: false,
  component: false,
  building: true,
  built: true,
  failed: true,
};

/**
 * Drift rule v2 — hierarchy-transparent, one note per unsatisfied edge.
 *
 * Mapping: each intent node maps to the set of reality packages its own
 * `codeRefs` cover (longest package dir wins per ref, so a nested package beats
 * its parent). A node *covers* package P if it or any descendant maps into P —
 * hierarchy is transparent, so `the service` covers whatever its child
 * `no door lock` points at.
 *
 * A. Undeclared dependency. A reality edge P->Q is satisfied when either
 *    - some intent node's own codeRefs straddle both P and Q (the dependency
 *      lives inside one bubble; there is nothing to draw), or
 *    - some intent edge of any kind runs from a node covering P to a node
 *      covering Q. Direction matters here: imports have a source and a target,
 *      so a P->Q import is not answered by a Q->P edge.
 *    An unsatisfied edge yields exactly ONE note, on the owner of P: the
 *    highest-altitude node covering P (ties: a node whose own refs map into P
 *    first, then document order). Descendants stay clean; the web bubbles drift
 *    up to visible ancestors anyway.
 *
 * B. Phantom dependency (unchanged in spirit, same evaluation). A declared
 *    `depends` edge whose ends are both `building`+ is contradicted only when no
 *    reality edge connects any package covered by the source to any package
 *    covered by the target. That test is direction-blind on purpose: a backwards
 *    declaration is already reported once by rule A, and reporting it twice
 *    would be noise. Ends that share a package are skipped — an intra-package
 *    dependency can never show up as a cross-package import.
 *
 * C. Vanished part. A `${file}#${Name}` codeRef whose file the reality layer
 *    did read, but which declares no such class or function any more, is a
 *    claim on something that is gone. The note lands on the bubble that makes
 *    the claim, not on an ancestor: a ref this precise names one bubble's own
 *    business. A file reality never parsed says nothing either way, so nothing
 *    is reported for it — that keeps a config ref or an older extraction from
 *    inventing drift.
 */
export function computeDrift(
  doc: Pick<GraphDoc, "nodes" | "edges">,
  reality: RealityLayer,
): DriftMap {
  const drift: DriftMap = {};
  const note = (nodeId: string, text: string): void => {
    const list = drift[nodeId];
    if (list === undefined) {
      drift[nodeId] = [text];
    } else if (!list.includes(text)) {
      list.push(text);
    }
  };

  // Longest dir first so a nested package wins over its parent; a root package
  // (dir ".") swallows every path, so it is always the last resort.
  const realityByDir = [...reality.nodes]
    .map((n) => ({ node: n, dir: normalizeIndexPath(n.dir) }))
    .sort((a, b) => {
      if ((a.dir === ".") !== (b.dir === ".")) return a.dir === "." ? 1 : -1;
      return b.dir.length - a.dir.length;
    });

  const intentById = new Map<string, IntentNode>();
  for (const node of doc.nodes) intentById.set(node.id, node);

  /** intent node id -> packages its OWN codeRefs land in */
  const ownPkgs = new Map<string, Set<string>>();
  for (const node of doc.nodes) {
    const refs = node.codeRefs;
    if (refs === undefined || refs.length === 0) continue;
    let pkgs: Set<string> | undefined;
    for (const raw of refs) {
      const ref = normalizeIndexPath(raw);
      if (ref.length === 0) continue;
      for (const cand of realityByDir) {
        if (cand.dir === "." || ref === cand.dir || ref.startsWith(cand.dir + "/")) {
          if (pkgs === undefined) pkgs = new Set<string>();
          pkgs.add(cand.node.id);
          break;
        }
      }
    }
    if (pkgs !== undefined) ownPkgs.set(node.id, pkgs);
  }

  /** Depth in the parentId tree; unknown/cyclic parents stop the walk. */
  const depthOf = new Map<string, number>();
  const depth = (id: string): number => {
    const memo = depthOf.get(id);
    if (memo !== undefined) return memo;
    let d = 0;
    const seen = new Set<string>([id]);
    let cur = intentById.get(id)?.parentId ?? null;
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      d += 1;
      cur = intentById.get(cur)?.parentId ?? null;
    }
    depthOf.set(id, d);
    return d;
  };

  /** intent node id -> packages covered by it or any descendant */
  const covers = new Map<string, Set<string>>();
  const addCover = (id: string, pkg: string): void => {
    const bucket = covers.get(id);
    if (bucket === undefined) covers.set(id, new Set<string>([pkg]));
    else bucket.add(pkg);
  };
  for (const [id, pkgs] of ownPkgs) {
    for (const pkg of pkgs) {
      addCover(id, pkg);
      // Lift to every ancestor; the seen-set doubles as the cycle guard.
      const seen = new Set<string>([id]);
      let cur = intentById.get(id)?.parentId ?? null;
      while (cur !== null && !seen.has(cur)) {
        seen.add(cur);
        addCover(cur, pkg);
        cur = intentById.get(cur)?.parentId ?? null;
      }
    }
  }

  /** package -> node ids covering it, in document order */
  const coveringNodes = new Map<string, string[]>();
  for (const node of doc.nodes) {
    const pkgs = covers.get(node.id);
    if (pkgs === undefined) continue;
    for (const pkg of pkgs) {
      const bucket = coveringNodes.get(pkg);
      if (bucket === undefined) coveringNodes.set(pkg, [node.id]);
      else bucket.push(node.id);
    }
  }

  /** The top-level bubble that owns a package, or null if nothing covers it. */
  const ownerOf = (pkg: string): string | null => {
    const candidates = coveringNodes.get(pkg);
    if (candidates === undefined || candidates.length === 0) return null;
    let best: string | null = null;
    let bestDepth = Number.POSITIVE_INFINITY;
    let bestOwn = false;
    for (const id of candidates) {
      const d = depth(id);
      const own = ownPkgs.get(id)?.has(pkg) === true;
      if (d < bestDepth || (d === bestDepth && own && !bestOwn)) {
        best = id;
        bestDepth = d;
        bestOwn = own;
      }
    }
    return best;
  };

  const realityLabel = new Map<string, string>();
  for (const n of reality.nodes) realityLabel.set(n.id, n.label);

  // A. undeclared dependency: code imports it, the canvas does not say so.
  for (const edge of reality.edges) {
    if (edge.source === edge.target) continue;
    if (!coveringNodes.has(edge.source) || !coveringNodes.has(edge.target)) continue;

    let satisfied = false;
    for (const pkgs of ownPkgs.values()) {
      if (pkgs.has(edge.source) && pkgs.has(edge.target)) {
        satisfied = true;
        break;
      }
    }
    if (!satisfied) {
      for (const e of doc.edges) {
        if (
          covers.get(e.source)?.has(edge.source) === true &&
          covers.get(e.target)?.has(edge.target) === true
        ) {
          satisfied = true;
          break;
        }
      }
    }
    if (satisfied) continue;

    const owner = ownerOf(edge.source);
    if (owner === null) continue;
    const targetPkg = realityLabel.get(edge.target) ?? edge.target;
    const targetOwner = ownerOf(edge.target);
    const targetLabel = targetOwner === null ? null : intentById.get(targetOwner)?.label ?? null;
    note(
      owner,
      targetLabel === null
        ? `code imports ${targetPkg} but no edge is declared`
        : `code imports ${targetPkg} (node "${targetLabel}") but no edge is declared`,
    );
  }

  // B. phantom dependency: the canvas declares it, the code has no such import.
  for (const edge of doc.edges) {
    if (edge.kind !== "depends") continue;
    const source = intentById.get(edge.source);
    const target = intentById.get(edge.target);
    if (source === undefined || target === undefined) continue;
    if (!REALIZED_PHASES[source.phase] || !REALIZED_PHASES[target.phase]) continue;
    const from = covers.get(edge.source);
    const to = covers.get(edge.target);
    if (from === undefined || to === undefined) continue;
    // Same package on both ends can never show a cross-package import.
    let shared = false;
    for (const p of from) {
      if (to.has(p)) {
        shared = true;
        break;
      }
    }
    if (shared) continue;
    let realized = false;
    for (const re of reality.edges) {
      if (
        (from.has(re.source) && to.has(re.target)) ||
        (from.has(re.target) && to.has(re.source))
      ) {
        realized = true;
        break;
      }
    }
    if (realized) continue;
    note(
      edge.source,
      `declared dependency on "${target.label}" has no corresponding import in code`,
    );
  }

  // C. vanished part: a ref names a class or function the file no longer has.
  // `symbols` is absent in a document written before the bridge read parts.
  const namesByFile = new Map<string, Set<string>>();
  for (const symbol of reality.symbols ?? []) {
    const bucket = namesByFile.get(symbol.file);
    if (bucket === undefined) namesByFile.set(symbol.file, new Set([symbol.name]));
    else bucket.add(symbol.name);
  }
  for (const node of doc.nodes) {
    if (!REALIZED_PHASES[node.phase]) continue;
    const refs = node.codeRefs;
    if (refs === undefined) continue;
    for (const raw of refs) {
      const ref = symbolRefOf(raw);
      if (ref === null) continue;
      const file = normalizeIndexPath(ref.path);
      const names = namesByFile.get(file);
      if (names === undefined || names.has(ref.name)) continue;
      note(node.id, `names a part of the code that is no longer there: ${ref.name} in ${file}`);
    }
  }

  return drift;
}
