import { readFile } from "node:fs/promises";
import path from "node:path";

import { extractReality } from "../../packages/bridge/src/agent/reality.ts";
import { repositoryIdentity } from "../../packages/bridge/src/agent/worktrees.ts";
import { requestControl, resolveConnection, shapeHome } from "../lib/client.mjs";
import {
  branchTip,
  cleanupPinnedSnapshot,
  createPinnedSnapshot,
  mapDiffContext,
  repositoryRoot,
  resolveLocalBranch,
  verifyPinnedSnapshot,
} from "../lib/map-git.mjs";
import {
  loadPreparation,
  newPreparation,
  removePreparationRecord,
  savePreparation,
} from "../lib/map-preparation.mjs";

const USAGE = `Usage:
  shape map prepare [branch] [--repo path] [--server origin] [--token token]
  shape map finish <preparationId> --ops <json-file>
  shape map abort <preparationId>

prepare pins a clean snapshot of a local branch (default: main) and prints the
repository evidence a semantic mapping skill needs. finish accepts a genuine
CanvasOp JSON array produced from that evidence; it does not invent a map.`;

function optionValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value === "--") {
    throw new Error(`${name} requires a value\n${USAGE}`);
  }
  return value;
}

function parsePrepare(args) {
  const options = { branch: "main", repo: process.cwd(), server: undefined, token: undefined };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--repo" || arg === "--server" || arg === "--token") {
      const value = optionValue(args, index, arg);
      index += 1;
      if (arg === "--repo") options.repo = value;
      else if (arg === "--server") options.server = value;
      else options.token = value;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option ${arg}\n${USAGE}`);
    positional.push(arg);
  }
  if (positional.length > 1) throw new Error(`prepare accepts at most one branch\n${USAGE}`);
  if (positional[0] !== undefined) options.branch = positional[0];
  return options;
}

function parseFinish(args) {
  const positional = [];
  let opsFile;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--ops") {
      opsFile = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option ${arg}\n${USAGE}`);
    positional.push(arg);
  }
  if (positional.length !== 1 || opsFile === undefined) throw new Error(USAGE);
  return { preparationId: positional[0], opsFile };
}

function parseAbort(args) {
  const positional = args.filter((arg) => arg !== "--");
  if (positional.length !== 1 || positional[0].startsWith("--")) throw new Error(USAGE);
  return { preparationId: positional[0] };
}

function isRepository(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    typeof value.id === "string" && value.id.length > 0 &&
    typeof value.label === "string" && value.label.length > 0 &&
    typeof value.path === "string" && value.path.length > 0;
}

function assertMapState(response, repository, branch) {
  if (
    response === null || typeof response !== "object" || response.type !== "map_state" ||
    !isRepository(response.repository) || response.repository.id !== repository.id ||
    response.branch !== branch || !Number.isSafeInteger(response.revision) || response.revision < 0 ||
    response.mappedCommit !== null && typeof response.mappedCommit !== "string" ||
    response.doc !== null && (typeof response.doc !== "object" || Array.isArray(response.doc))
  ) {
    throw new Error("Shape control returned an invalid map_state response");
  }
}

function assertPreparation(record) {
  const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  const validMode = record.mode === "initial" || record.mode === "incremental" || record.mode === "full";
  const validCommit = typeof record.toCommit === "string" && oid.test(record.toCommit);
  const validFrom = record.fromCommit === null || typeof record.fromCommit === "string" && oid.test(record.fromCommit);
  const validMapped = record.mappedCommit === null || typeof record.mappedCommit === "string" && oid.test(record.mappedCommit);
  const validReality = record.reality !== null && typeof record.reality === "object" &&
    Array.isArray(record.reality.nodes) && Array.isArray(record.reality.edges) &&
    Array.isArray(record.reality.symbols) && Array.isArray(record.reality.infra) &&
    Array.isArray(record.reality.verification);
  const validConnection = record.connection !== null && typeof record.connection === "object" &&
    typeof record.connection.server === "string" &&
    (record.connection.token === undefined || typeof record.connection.token === "string");
  if (
    !isRepository(record.repository) || typeof record.branch !== "string" ||
    !record.branch.startsWith("refs/heads/") || record.ref !== record.branch ||
    !validCommit || !validFrom || !validMode ||
    !Number.isSafeInteger(record.revision) || record.revision < 0 || !validMapped ||
    !Array.isArray(record.changedPaths) || !record.changedPaths.every((item) => typeof item === "string") ||
    !validReality || !validConnection
  ) {
    throw new Error(`mapping preparation ${record.preparationId} is corrupt`);
  }
}

async function readOps(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.resolve(file), "utf8"));
  } catch (error) {
    throw new Error(`cannot read CanvasOp JSON from ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("--ops JSON must be a top-level CanvasOp array");
  for (const [index, op] of parsed.entries()) {
    if (op === null || typeof op !== "object" || Array.isArray(op) || typeof op.op !== "string") {
      throw new Error(`--ops entry ${index} is not a CanvasOp object`);
    }
  }
  return parsed;
}

function canvasUrl(server) {
  return new URL("/", server).toString();
}

async function cleanupPreparation(paths, record) {
  await cleanupPinnedSnapshot({ repoRoot: record.repoRoot, snapshotPath: paths.snapshotPath });
  await removePreparationRecord(paths);
}

async function printReceiptAfterCleanup(paths, record, receipt) {
  try {
    await cleanupPreparation(paths, record);
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    console.log(JSON.stringify({
      ...receipt,
      cleanupPending: true,
      preparationId: record.preparationId,
      cleanupError: error instanceof Error ? error.message : String(error),
    }, null, 2));
  }
}

async function prepare(args) {
  const cli = parsePrepare(args);
  const repoRoot = await repositoryRoot(path.resolve(cli.repo));
  const selected = await resolveLocalBranch(repoRoot, cli.branch);
  const repository = await repositoryIdentity(repoRoot);
  const connection = await resolveConnection({ server: cli.server, token: cli.token });
  const state = await requestControl({ type: "map_read", repository, branch: selected.branch }, connection);
  assertMapState(state, repository, selected.branch);

  const context = await mapDiffContext(
    repoRoot,
    state.mappedCommit,
    selected.commit,
    state.doc !== null || state.mappedCommit !== null,
    state.doc !== null,
  );
  const paths = newPreparation(shapeHome());
  let snapshotCreated = false;
  try {
    await createPinnedSnapshot({
      repoRoot,
      snapshotPath: paths.snapshotPath,
      commit: selected.commit,
      preparationId: paths.preparationId,
    });
    snapshotCreated = true;
    const reality = await extractReality(paths.snapshotPath);
    const currentTip = await branchTip(repoRoot, selected.ref);
    if (currentTip !== selected.commit) {
      throw new Error(`branch ${selected.ref} moved from ${selected.commit} to ${currentTip ?? "missing"} during preparation`);
    }

    const record = {
      version: 1,
      preparationId: paths.preparationId,
      createdAt: new Date().toISOString(),
      snapshotPath: paths.snapshotPath,
      repoRoot,
      repository,
      branch: selected.branch,
      ref: selected.ref,
      fromCommit: context.fromCommit,
      toCommit: selected.commit,
      mode: context.mode,
      revision: state.revision,
      mappedCommit: state.mappedCommit,
      changedPaths: context.changedPaths,
      reality,
      connection,
    };
    await savePreparation(paths, record);
    console.log(JSON.stringify({
      preparationId: paths.preparationId,
      snapshotPath: paths.snapshotPath,
      repository,
      branch: selected.branch,
      fromCommit: context.fromCommit,
      toCommit: selected.commit,
      mode: context.mode,
      revision: state.revision,
      mappedCommit: state.mappedCommit,
      doc: state.doc,
      changedPaths: context.changedPaths,
      diff: context.diff,
      reality,
    }, null, 2));
  } catch (error) {
    let cleanupError = error?.snapshotRetained === true ? error : null;
    if (snapshotCreated) {
      try {
        await cleanupPinnedSnapshot({ repoRoot, snapshotPath: paths.snapshotPath });
      } catch (failure) {
        cleanupError = failure;
      }
    }
    if (cleanupError !== null) {
      await savePreparation(paths, {
        version: 1,
        preparationId: paths.preparationId,
        snapshotPath: paths.snapshotPath,
        repoRoot,
        cleanupOnly: true,
      }).catch((failure) => {
        if (failure?.code !== "EEXIST") throw failure;
      });
      throw new AggregateError(
        [error, cleanupError],
        `mapping preparation failed and cleanup is incomplete; run shape map abort ${paths.preparationId}`,
      );
    }
    await removePreparationRecord(paths).catch(() => undefined);
    throw error;
  }
}

async function finish(args) {
  const cli = parseFinish(args);
  const ops = await readOps(cli.opsFile);
  const { paths, record } = await loadPreparation(shapeHome(), cli.preparationId);
  assertPreparation(record);

  const tip = await branchTip(record.repoRoot, record.ref);
  if (tip !== record.toCommit) {
    throw new Error(`branch ${record.ref} moved from prepared commit ${record.toCommit} to ${tip ?? "missing"}; abort and prepare again`);
  }
  await verifyPinnedSnapshot({ snapshotPath: paths.snapshotPath, commit: record.toCommit });

  const noDiff = record.mode === "incremental" && record.fromCommit === record.toCommit && record.changedPaths.length === 0;
  if (noDiff && ops.length === 0) {
    const current = await requestControl(
      { type: "map_read", repository: record.repository, branch: record.branch },
      record.connection,
    );
    assertMapState(current, record.repository, record.branch);
    if (current.mappedCommit !== record.toCommit) {
      throw new Error(`mapping checkpoint changed from ${record.toCommit} to ${current.mappedCommit ?? "missing"}; preparation was retained`);
    }
    await printReceiptAfterCleanup(paths, record, {
      projectId: record.repository.id,
      branch: record.branch,
      revision: current.revision,
      mappedCommit: current.mappedCommit,
      canvasUrl: canvasUrl(record.connection.server),
      committed: false,
    });
    return;
  }

  const response = await requestControl({
    type: "map_commit",
    repository: record.repository,
    branch: record.branch,
    expectedRevision: record.revision,
    expectedMappedCommit: record.mappedCommit,
    commit: record.toCommit,
    mode: record.mode,
    ops,
    reality: record.reality,
  }, record.connection);
  if (
    response === null || typeof response !== "object" || response.type !== "map_committed" ||
    typeof response.projectId !== "string" || response.projectId.length === 0 ||
    response.projectId !== record.repository.id ||
    response.branch !== record.branch || !Number.isSafeInteger(response.revision) || response.revision < 0 ||
    response.mappedCommit !== record.toCommit
  ) {
    throw new Error("Shape control returned an invalid map_committed response; preparation was retained");
  }
  await printReceiptAfterCleanup(paths, record, {
    projectId: response.projectId,
    branch: response.branch,
    revision: response.revision,
    mappedCommit: response.mappedCommit,
    canvasUrl: canvasUrl(record.connection.server),
    committed: true,
  });
}

async function abort(args) {
  const cli = parseAbort(args);
  const { paths, record } = await loadPreparation(shapeHome(), cli.preparationId);
  if (typeof record.repoRoot !== "string" || record.repoRoot.length === 0) {
    throw new Error(`mapping preparation ${cli.preparationId} is corrupt`);
  }
  await cleanupPreparation(paths, record);
  console.log(JSON.stringify({ preparationId: cli.preparationId, aborted: true }, null, 2));
}

export async function run(args) {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const [command, ...rest] = args;
  if (command === "prepare") return prepare(rest);
  if (command === "finish") return finish(rest);
  if (command === "abort") return abort(rest);
  throw new Error(`unknown map command ${command}\n${USAGE}`);
}
