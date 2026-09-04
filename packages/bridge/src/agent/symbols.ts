/**
 * Symbol extraction: the top-level classes and functions inside the files the
 * reality scan already admits. This is the "inside" of a leaf build bubble —
 * the parts a child bubble claims with a `${file}#${Name}` codeRef, the parts
 * the onboarding gate checks a claim against, and the parts drift notices have
 * disappeared.
 *
 * Only the declarations a reader would call the shape of a file are recorded:
 * top-level classes, top-level functions, and top-level consts holding a
 * function. Nothing nested, nothing inferred — a claim must point at something
 * a person can find by opening the file.
 *
 * The parse is the TypeScript compiler's own, but only its parser: no program,
 * no type checker, no config resolution. A file that does not parse cleanly
 * still yields whatever the recovering parser managed to read.
 */

import ts from "typescript";

import type { RealitySymbol } from "../../../shared/src/index.ts";

/**
 * Total symbol cap. A monorepo of a few thousand files lands in the low
 * thousands of symbols; 20 000 is the point where the layer stops being a map
 * of the code and starts being a dump of it, so extraction stops there rather
 * than sending a browser something it cannot draw.
 */
export const MAX_SYMBOLS = 20_000;

/**
 * ScriptKind decides how the parser reads the text: JSX has to be enabled per
 * file (`<T>(x)` is a cast in .ts and an element in .tsx), and .mjs/.cjs are
 * plain JS. Anything unrecognized is read as TypeScript, which is the most
 * permissive of the set.
 */
function scriptKindOf(file: string): ts.ScriptKind {
  const dot = file.lastIndexOf(".");
  switch (dot < 0 ? "" : file.slice(dot).toLowerCase()) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  if (modifiers === undefined) return false;
  for (const modifier of modifiers) {
    if (modifier.kind === ts.SyntaxKind.ExportKeyword) return true;
  }
  return false;
}

/**
 * Names a later `export { x, y as z }` in the same file publishes. The LOCAL
 * name is what matters (`export { login as signIn }` exports the declaration
 * called `login`), and a re-export with a module specifier publishes someone
 * else's declaration, so it says nothing about this file's.
 */
function exportedByList(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (statement.moduleSpecifier !== undefined) continue;
    const clause = statement.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) continue;
    for (const spec of clause.elements) {
      names.add((spec.propertyName ?? spec.name).text);
    }
  }
  return names;
}

/**
 * The top-level declarations of one already-read file, appended to `out`.
 * Returns false when the cap stopped it mid-file, so the caller can stop too.
 *
 * Duplicate names in one file collapse to the first declaration: overload
 * signatures are one part of the code, not three, and a codeRef naming it
 * must resolve to one place.
 */
function collectFile(
  rel: string,
  text: string,
  pkg: string | null,
  out: RealitySymbol[],
): boolean {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, scriptKindOf(rel));
  const listed = exportedByList(source);
  const seen = new Set<string>();

  const push = (name: ts.Identifier, kind: "class" | "function", exported: boolean): boolean => {
    if (out.length >= MAX_SYMBOLS) return false;
    if (seen.has(name.text)) return true;
    seen.add(name.text);
    out.push({
      id: `s:${rel}#${name.text}`,
      file: rel,
      name: name.text,
      kind,
      exported: exported || listed.has(name.text),
      line: source.getLineAndCharacterOfPosition(name.getStart(source)).line + 1,
      pkg,
    });
    return true;
  };

  for (const statement of source.statements) {
    if (ts.isClassDeclaration(statement)) {
      // `export default class {}` has no name: there is nothing to point at
      if (statement.name === undefined) continue;
      if (!push(statement.name, "class", hasExportModifier(statement))) return false;
      continue;
    }
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name === undefined) continue;
      if (!push(statement.name, "function", hasExportModifier(statement))) return false;
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const exported = hasExportModifier(statement);
      for (const decl of statement.declarationList.declarations) {
        // a const holding a function is a part of the code; a const holding a
        // number is not
        const init = decl.initializer;
        if (init === undefined || !(ts.isArrowFunction(init) || ts.isFunctionExpression(init))) continue;
        if (!ts.isIdentifier(decl.name)) continue;
        if (!push(decl.name, "function", exported)) return false;
      }
    }
  }
  return true;
}

/**
 * The symbols of every file in `files` (absolute paths, already scoped and
 * capped by the reality scan).
 *
 * `readSource` belongs to the caller so one read serves both passes: the
 * reality scan needs the same text for its import scan, and reading a whole
 * repo twice to answer two questions about the same bytes would be waste. It
 * returns null for anything unreadable or over the scan's size limit, and such
 * a file simply has no symbols.
 *
 * `pkgOf` maps a file to the reality package id that owns it (null outside
 * every package) — the same mapping the scan already computed.
 */
export async function extractSymbols(
  cwd: string,
  files: readonly string[],
  pkgOf: (file: string) => string | null,
  readSource: (file: string) => Promise<string | null>,
): Promise<RealitySymbol[]> {
  const symbols: RealitySymbol[] = [];
  let capped = false;
  for (const file of files) {
    // the read happens even past the cap: it is the caller's read too, and the
    // reality scan still needs this file's imports
    const text = await readSource(file);
    if (text === null || capped) continue;
    const rel = relativePosix(cwd, file);
    if (rel === null) continue;
    if (!collectFile(rel, text, pkgOf(file), symbols)) {
      capped = true;
      console.error(
        `shape: stopped reading symbols at ${MAX_SYMBOLS} — this project has more classes and functions than the canvas can show`,
      );
    }
  }
  return symbols;
}

/**
 * Workspace-relative posix path, or null for anything outside the root. Kept
 * here rather than imported so this module stays a parser with one dependency.
 */
function relativePosix(cwd: string, file: string): string | null {
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const abs = file.replace(/\\/g, "/");
  if (!abs.startsWith(`${root}/`)) return null;
  const rel = abs.slice(root.length + 1);
  return rel.length === 0 ? null : rel;
}
