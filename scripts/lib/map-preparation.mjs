import { open, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newPreparation(shapeHome) {
  const preparationId = randomUUID();
  const root = path.resolve(shapeHome, "map");
  return {
    preparationId,
    root,
    snapshotPath: path.join(root, "snapshots", preparationId),
    recordPath: path.join(root, "preparations", `${preparationId}.json`),
  };
}

export function preparationPaths(shapeHome, preparationId) {
  if (!ID_RE.test(preparationId)) throw new Error("invalid mapping preparation ID");
  const root = path.resolve(shapeHome, "map");
  return {
    preparationId,
    root,
    snapshotPath: path.join(root, "snapshots", preparationId),
    recordPath: path.join(root, "preparations", `${preparationId}.json`),
  };
}

export async function savePreparation(paths, record) {
  const directory = path.dirname(paths.recordPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(paths.recordPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function loadPreparation(shapeHome, preparationId) {
  const paths = preparationPaths(shapeHome, preparationId);
  let text;
  try {
    const info = await stat(paths.recordPath);
    if (!info.isFile()) throw new Error("not a file");
    text = await readFile(paths.recordPath, "utf8");
  } catch {
    throw new Error(`mapping preparation ${preparationId} does not exist`);
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error(`mapping preparation ${preparationId} is corrupt`);
  }
  if (
    record === null || typeof record !== "object" || Array.isArray(record) ||
    record.version !== 1 || record.preparationId !== preparationId ||
    record.snapshotPath !== paths.snapshotPath || typeof record.repoRoot !== "string"
  ) {
    throw new Error(`mapping preparation ${preparationId} is invalid`);
  }
  return { paths, record };
}

export async function removePreparationRecord(paths) {
  await rm(paths.recordPath, { force: true });
}
