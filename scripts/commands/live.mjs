import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { requestControl, resolveConnection } from "../lib/client.mjs";
import {
  assertHandleMatchesCheckout,
  createSessionId,
  loadLiveHandle,
  normalizeReportedFiles,
  removeLiveHandle,
  resolveLiveCheckout,
  saveLiveHandle,
  updateLiveHandle,
  withLiveHandleLock,
} from "../lib/live-session.mjs";

const USAGE = `Usage:
  shape live start [--repo <path>] [--server <origin>] [--token <token>] [--note <text>] [--tool <name>] [--files <path> ...]
  shape live emit --session <handle> [--repo <path>] [--server <origin>] [--token <token>] [--ops <json-file>] [--note <text>] [--tool <name>] [--files <path> ...] [--state working|idle]
  shape live stop --session <handle> [--repo <path>] [--server <origin>] [--token <token>]

Starts, updates, or stops a skill-reported live session in the current Git branch without restarting the harness. Start prints a generated session handle; pass that exact handle to every emit and stop. A credential-free recovery handle is created under Shape home before the start request, retained when the outcome is ambiguous, and marked stopped only after an acknowledged stop. --files is repeatable and accepts one repository-relative path per occurrence. --ops accepts a JSON array of CanvasOp objects or an object containing only an ops array. Live updates change the visible graph and activity only; the committed mapping baseline and mapped commit remain unchanged.`;

const VALUE_OPTIONS = new Set(["repo", "server", "token", "session", "ops", "note", "tool", "files", "state"]);
const REPEATABLE_OPTIONS = new Set(["files"]);

function fail(message) {
  const error = new Error(message);
  error.name = "ShapeLiveUsageError";
  throw error;
}

function parseArgs(args) {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h") {
    return { help: true };
  }
  if (command !== "start" && command !== "emit" && command !== "stop") {
    fail(`unknown live command ${JSON.stringify(command)}; expected start, emit, or stop`);
  }

  const options = { files: [] };
  for (let index = 1; index < args.length; index += 1) {
    const raw = args[index];
    if (raw === "--help" || raw === "-h") return { help: true };
    if (raw === undefined || !raw.startsWith("--")) fail(`unexpected argument ${JSON.stringify(raw)}`);
    const equal = raw.indexOf("=");
    const name = raw.slice(2, equal === -1 ? undefined : equal);
    if (!VALUE_OPTIONS.has(name)) fail(`unknown option --${name}`);
    const value = equal === -1 ? args[++index] : raw.slice(equal + 1);
    if (value === undefined || value.length === 0 || (equal === -1 && value.startsWith("--"))) fail(`--${name} needs a value`);
    if (REPEATABLE_OPTIONS.has(name)) options.files.push(value);
    else {
      if (options[name] !== undefined) fail(`--${name} may only be specified once`);
      options[name] = value;
    }
  }

  const allowed = {
    start: new Set(["repo", "server", "token", "note", "tool", "files"]),
    emit: new Set(["repo", "server", "token", "session", "ops", "note", "tool", "files", "state"]),
    stop: new Set(["repo", "server", "token", "session"]),
  }[command];
  for (const name of Object.keys(options)) {
    if (name === "files" && options.files.length === 0) continue;
    if (!allowed.has(name)) fail(`--${name} is not valid with live ${command}`);
  }
  if ((command === "emit" || command === "stop") && options.session === undefined) {
    fail(`live ${command} requires --session <handle> from live start`);
  }
  if (options.note !== undefined && options.note.trim().length === 0) fail("--note must not be blank");
  if (options.tool !== undefined && options.tool.trim().length === 0) fail("--tool must not be blank");
  if (options.state !== undefined && options.state !== "working" && options.state !== "idle") {
    fail("--state must be working or idle; start and stop use their dedicated commands");
  }
  return { help: false, command, options };
}

async function readOps(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`cannot read --ops ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const wrapped = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if (wrapped && (Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "ops"))) {
    throw new Error(`--ops ${JSON.stringify(path)} object must contain only an ops array`);
  }
  const ops = Array.isArray(parsed) ? parsed : wrapped ? parsed.ops : undefined;
  if (!Array.isArray(ops)) throw new Error(`--ops ${JSON.stringify(path)} must contain a JSON array or an object with an ops array`);
  for (const [index, op] of ops.entries()) {
    if (op === null || typeof op !== "object" || Array.isArray(op) || typeof op.op !== "string") {
      throw new Error(`--ops ${JSON.stringify(path)} has an invalid operation at index ${index}`);
    }
  }
  return ops;
}

function liveRequest({ repository, branch, sessionId, state, ops, note, tool, files }) {
  return {
    type: "live_update",
    repository,
    branch,
    sessionId,
    state,
    ...(ops === undefined ? {} : { ops }),
    ...(note === undefined ? {} : { note }),
    ...(tool === undefined ? {} : { tool }),
    ...(files === undefined || files.length === 0 ? {} : { files }),
  };
}

function assertLiveResponse(response, branch) {
  if (
    response === null ||
    typeof response !== "object" ||
    response.type !== "live_updated" ||
    typeof response.projectId !== "string" ||
    response.projectId.length === 0 ||
    response.branch !== branch ||
    !Number.isInteger(response.revision) ||
    response.revision < 0 ||
    typeof response.mappedCommit !== "string"
  ) {
    throw new Error("Shape server returned an invalid live_updated response");
  }
}

function receipt(response, { sessionId, repository, state, server }) {
  return {
    ok: true,
    session: sessionId,
    repository,
    projectId: response.projectId,
    branch: response.branch,
    state,
    revision: response.revision,
    mappedCommit: response.mappedCommit,
    canvasUrl: server,
  };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function connectionForHandle(handle, options) {
  const connection = await resolveConnection({ server: options.server ?? handle.server, token: options.token });
  if (connection.server !== handle.server) {
    throw new Error(
      `live session ${handle.sessionId} belongs to Shape server ${handle.server}; refusing to send it to ${connection.server}`,
    );
  }
  return connection;
}

function isDefinitiveControlFailure(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    ["invalid", "not_mapped", "conflict", "AUTH_REQUIRED", "UPGRADE_FAILED", "INSECURE_TRANSPORT"].includes(error.code)
  );
}

async function start(options) {
  const checkout = await resolveLiveCheckout(options.repo);
  const connection = await resolveConnection({ server: options.server, token: options.token });
  const sessionId = createSessionId();
  const files = normalizeReportedFiles(options.files, checkout.root);
  const request = liveRequest({
    repository: checkout.repository,
    branch: checkout.branch,
    sessionId,
    state: "start",
    note: options.note,
    tool: options.tool,
    files,
  });

  const handle = {
    sessionId,
    repository: checkout.repository,
    branch: checkout.branch,
    server: connection.server,
    createdAt: new Date().toISOString(),
  };
  try {
    await saveLiveHandle(handle);
  } catch (error) {
    throw new Error(
      `cannot create recovery handle for live session ${sessionId}; no control request was sent: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let response;
  try {
    response = await requestControl(request, connection);
    assertLiveResponse(response, checkout.branch);
  } catch (error) {
    if (isDefinitiveControlFailure(error)) {
      try {
        await removeLiveHandle(sessionId);
      } catch (cleanupError) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; the rejected start's pending handle ${sessionId} could not be removed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      throw error;
    }
    throw new Error(
      `live start was not acknowledged; recovery handle ${sessionId} is retained. Run live stop --session ${sessionId} from this repository before retrying. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    await updateLiveHandle({ ...handle, status: "pending" }, "active");
  } catch (error) {
    throw new Error(
      `Shape started live session ${sessionId}, but its recovery handle could not be marked active. Run live stop --session ${sessionId} from this repository: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  print(receipt(response, { sessionId, repository: checkout.repository, state: "start", server: connection.server }));
}

async function emit(options) {
  await withLiveHandleLock(options.session, async () => {
    const handle = await loadLiveHandle(options.session);
    if (handle.status !== "active") {
      const guidance =
        handle.status === "stopped"
          ? "it is already stopped"
          : "its start was not acknowledged; run live stop with this handle before starting again";
      throw new Error(`cannot emit for live session ${handle.sessionId}: ${guidance}`);
    }
    const checkout = await resolveLiveCheckout(options.repo, handle.branch);
    assertHandleMatchesCheckout(handle, checkout);
    const connection = await connectionForHandle(handle, options);
    const ops = options.ops === undefined ? undefined : await readOps(options.ops);
    const files = normalizeReportedFiles(options.files, checkout.root);
    const state = options.state ?? "working";
    let response;
    try {
      response = await requestControl(
        liveRequest({
          repository: handle.repository,
          branch: handle.branch,
          sessionId: handle.sessionId,
          state,
          ops,
          note: options.note,
          tool: options.tool,
          files,
        }),
        connection,
      );
      assertLiveResponse(response, handle.branch);
    } catch (error) {
      if (isDefinitiveControlFailure(error)) throw error;
      throw new Error(
        `live emit for session ${handle.sessionId} was not acknowledged and may already have applied. Do not blindly retry semantic ops; inspect the canvas or server state first. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    print(receipt(response, { sessionId: handle.sessionId, repository: handle.repository, state, server: connection.server }));
  });
}

async function stop(options) {
  await withLiveHandleLock(options.session, async () => {
    const handle = await loadLiveHandle(options.session);
    if (handle.status === "stopped") {
      print({ ok: true, session: options.session, state: "stop", alreadyStopped: true });
      return;
    }
    const checkout = await resolveLiveCheckout(options.repo, handle.branch);
    assertHandleMatchesCheckout(handle, checkout);
    const connection = await connectionForHandle(handle, options);
    const response = await requestControl(
      liveRequest({ repository: handle.repository, branch: handle.branch, sessionId: handle.sessionId, state: "stop" }),
      connection,
    );
    assertLiveResponse(response, handle.branch);
    try {
      await updateLiveHandle(handle, "stopped");
    } catch (error) {
      throw new Error(
        `Shape stopped live session ${handle.sessionId}, but its local stopped record could not be saved; retry stop with the same handle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    print(receipt(response, { sessionId: handle.sessionId, repository: handle.repository, state: "stop", server: connection.server }));
  });
}

export async function run(args) {
  const parsed = parseArgs(args);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (parsed.command === "start") await start(parsed.options);
  else if (parsed.command === "emit") await emit(parsed.options);
  else await stop(parsed.options);
}
