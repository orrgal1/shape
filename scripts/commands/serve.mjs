import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectionCandidates,
  normalizeServer,
  probeConnection,
  resolveConnection,
  saveConnection,
  shapeHome,
} from "../lib/client.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_CLI = fileURLToPath(new URL("../../packages/bridge/src/server-cli.ts", import.meta.url));
const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../packages/web/dist", import.meta.url));
const START_TIMEOUT_MS = 10_000;

const HELP = `Usage:
  shape serve discover [--server <origin>]...
  shape serve connect <origin> [--token <token>]
  shape serve start [--host <host>] [--port <port>] [--data-dir <dir>]
                    [--token-file <file>] [--web-dir <dir>]
  shape serve --help

Commands:
  discover  Probe explicit, environment, saved, and default endpoints without
            selecting, saving, or starting anything.
  connect   Verify Shape health and authenticated control access, then save the
            selected endpoint and credentials privately.
  start     Run the real Shape HTTP/WebSocket server in the foreground.

Environment:
  SHAPE_SERVER  Server origin used when no explicit origin is supplied.
  SHAPE_TOKEN   Token used when no explicit token is supplied.
  SHAPE_HOME    Parent of the existing .shape/servers.json credential store.

All machine-readable command results are one JSON object on stdout. Tokens are
never included in output. Remote tokens require HTTPS or a loopback SSH tunnel.`;

function parseOptions(args, allowed) {
  const options = {};
  const positionals = [];
  let positionalOnly = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (positionalOnly || !argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }

    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (!allowed.has(name)) throw new Error(`unknown option ${name}`);
    const value = equals === -1 ? args[++index] : argument.slice(equals + 1);
    if (value === undefined || value.length === 0 || (equals === -1 && value.startsWith("--"))) {
      throw new Error(`${name} requires a value`);
    }
    if (name === "--server") {
      (options.server ??= []).push(value);
    } else {
      if (options[name] !== undefined) throw new Error(`${name} may only be supplied once`);
      options[name] = value;
    }
  }
  return { options, positionals };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function canvasUrl(server) {
  return `${normalizeServer(server)}/`;
}

async function discover(args) {
  const { options, positionals } = parseOptions(args, new Set(["--server"]));
  if (positionals.length > 0) throw new Error(`discover does not accept positional arguments: ${positionals.join(" ")}`);
  const candidates = await connectionCandidates(options.server ?? []);
  const reports = await Promise.all(candidates.map(async ({ sources, connection }) => ({
    ...(await probeConnection(connection)),
    sources,
  })));
  print({ command: "discover", candidates: reports });
}

async function connect(args) {
  const { options, positionals } = parseOptions(args, new Set(["--token"]));
  if (positionals.length !== 1) throw new Error("usage: shape serve connect <origin> [--token <token>]");
  const connection = await resolveConnection({ server: positionals[0], token: options["--token"] });
  const report = await probeConnection(connection);
  if (report.status !== "reachable") {
    throw new Error(`cannot save ${connection.server}: ${report.message ?? report.status}`);
  }
  await saveConnection(connection);
  print({ command: "connect", server: connection.server, canvasUrl: canvasUrl(connection.server), saved: true });
}

function parsePort(raw) {
  if (!/^\d+$/.test(raw)) throw new Error(`--port expects an integer from 1 to 65535, got ${raw}`);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port expects an integer from 1 to 65535, got ${raw}`);
  }
  return port;
}

function parseHost(raw) {
  let host = raw.trim();
  const hasOpeningBracket = host.startsWith("[");
  const hasClosingBracket = host.endsWith("]");
  if (hasOpeningBracket !== hasClosingBracket) {
    throw new Error(`--host has unmatched IPv6 brackets: ${raw}`);
  }
  if (hasOpeningBracket) host = host.slice(1, -1);
  const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;
  if (host.length === 0 || (isIP(host) === 0 && !hostname.test(host))) {
    throw new Error(`--host expects a hostname or IP address, got ${raw}`);
  }
  return host;
}

async function requireFile(path, label) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} not found at ${path}`);
    throw new Error(`cannot inspect ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!info.isFile()) throw new Error(`${label} is not a file: ${path}`);
  await access(path);
}

async function validateStart(options) {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 26) {
    throw new Error(`Shape requires Node 26 or newer; current Node is ${process.versions.node}`);
  }

  const host = parseHost(options["--host"] ?? "127.0.0.1");
  const port = parsePort(options["--port"] ?? "4400");
  const dataDir = resolve(options["--data-dir"] ?? join(shapeHome(), "server"));
  const tokenFile = options["--token-file"] === undefined ? undefined : resolve(options["--token-file"]);
  const webDir = resolve(options["--web-dir"] ?? DEFAULT_WEB_DIR);

  await requireFile(SERVER_CLI, "Shape server entrypoint");
  try {
    const require = createRequire(new URL("../../packages/bridge/package.json", import.meta.url));
    require.resolve("ws");
  } catch {
    throw new Error(`Shape dependencies are missing; run pnpm install in ${ROOT}`);
  }

  try {
    const info = await stat(dataDir);
    if (!info.isDirectory()) throw new Error(`--data-dir is not a directory: ${dataDir}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await requireFile(join(webDir, "index.html"), `Shape web build (run pnpm --filter @shape/web build in ${ROOT})`);

  const { isLoopbackHost, loadTokenFile } = await import("../../packages/bridge/src/server/auth.ts");
  if (tokenFile !== undefined) {
    await requireFile(tokenFile, "token file");
    await loadTokenFile(tokenFile);
  } else if (!isLoopbackHost(host)) {
    throw new Error(`refusing to listen on ${host} without --token-file`);
  }

  return { host, port, dataDir, tokenFile, webDir };
}

function originForBind(host, port) {
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

async function waitUntilHealthy(server, child, exited, ready) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let startupTimer;
  const startup = await Promise.race([
    ready.then(() => ({ ready: true })),
    exited.then(({ code, signal }) => ({ exited: true, code, signal })),
    new Promise((resolveTimeout) => {
      startupTimer = setTimeout(() => resolveTimeout({ timedOut: true }), START_TIMEOUT_MS);
      startupTimer.unref?.();
    }),
  ]);
  clearTimeout(startupTimer);
  if (startup.exited) {
    throw new Error(`Shape server exited before listening (${startup.signal ?? `status ${startup.code}`})`);
  }
  if (startup.timedOut) {
    child.kill("SIGTERM");
    throw new Error(`Shape server did not begin listening within ${START_TIMEOUT_MS / 1000} seconds`);
  }

  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      exited.then(({ code, signal }) => ({ exited: true, code, signal })),
      fetch(new URL("/api/health", server), {
        signal: AbortSignal.timeout(500),
        redirect: "manual",
      }).then(async (response) => {
        let body;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        return { healthy: response.ok && body?.service === "shape" && body?.protocolVersion === 1 };
      }).catch(() => ({ healthy: false })),
    ]);
    if (outcome.exited) {
      throw new Error(`Shape server exited before becoming healthy (${outcome.signal ?? `status ${outcome.code}`})`);
    }
    if (outcome.healthy) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`Shape server did not become healthy within ${START_TIMEOUT_MS / 1000} seconds`);
}

async function start(args) {
  const { options, positionals } = parseOptions(
    args,
    new Set(["--host", "--port", "--data-dir", "--token-file", "--web-dir"]),
  );
  if (positionals.length > 0) throw new Error(`start does not accept positional arguments: ${positionals.join(" ")}`);
  const config = await validateStart(options);
  const childArgs = [
    SERVER_CLI,
    "--host", config.host,
    "--port", String(config.port),
    "--data-dir", config.dataDir,
    "--web-dir", config.webDir,
  ];
  if (config.tokenFile !== undefined) childArgs.push("--token-file", config.tokenFile);

  const child = spawn(process.execPath, childArgs, { cwd: ROOT, stdio: ["inherit", "inherit", "inherit", "ipc"] });
  const ready = new Promise((resolveReady) => {
    child.on("message", (message) => {
      if (message?.type === "shape_server_ready") resolveReady();
    });
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const forwarders = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const forward = () => child.kill(signal);
    forwarders.set(signal, forward);
    process.on(signal, forward);
  }

  try {
    const server = originForBind(config.host, config.port);
    const healthServer = config.host === "0.0.0.0"
      ? originForBind("127.0.0.1", config.port)
      : config.host === "::"
        ? originForBind("::1", config.port)
        : server;
    await waitUntilHealthy(healthServer, child, exited, ready);
    print({
      command: "start",
      server,
      canvasUrl: canvasUrl(server),
      dataDir: config.dataDir,
      authenticated: config.tokenFile !== undefined,
    });
    const { code, signal } = await exited;
    if (signal !== null) {
      const signalNumber = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal];
      return signalNumber === undefined ? 1 : 128 + signalNumber;
    }
    if (code !== 0) throw new Error(`Shape server exited with status ${code}`);
  } finally {
    for (const [signal, forward] of forwarders) process.off(signal, forward);
  }
}

export async function run(args) {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const [command, ...rest] = args;
  if (command === "discover") return await discover(rest);
  if (command === "connect") return await connect(rest);
  if (command === "start") return await start(rest);
  throw new Error(`unknown serve command ${command}\n${HELP}`);
}
