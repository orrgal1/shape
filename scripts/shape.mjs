#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DISPATCHER_PATH = fileURLToPath(import.meta.url);
const COMMAND_MODULES = Object.freeze({
  serve: new URL("./commands/serve.mjs", import.meta.url),
  map: new URL("./commands/map.mjs", import.meta.url),
  live: new URL("./commands/live.mjs", import.meta.url),
  install: new URL("./commands/install.mjs", import.meta.url),
});

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export const HELP = `Shape command line

Usage:
  pnpm shape <command> [options]
  node ${shellQuote(DISPATCHER_PATH)} <command> [options]

Commands:
  serve     Discover, connect to, or start a Shape server
  map       Prepare, finish, or abort a semantic repository map
  live      Start, emit, or stop explicit live canvas activity
  install   Install Shape skills for OMP, Claude, or another harness

Install examples:
  pnpm shape install
  pnpm shape install omp
  pnpm shape install claude
  pnpm shape install --custom-dir ~/my-harness/skills

Run "pnpm shape <command> --help" for command-specific help.`;

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export async function run(args = []) {
  const [command, ...commandArgs] = args;

  if (command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return 0;
  }

  if (!command) {
    throw new CliError(`Missing command. Choose serve, map, live, or install.\n\n${HELP}`);
  }

  const moduleUrl = COMMAND_MODULES[command];
  if (!moduleUrl) {
    throw new CliError(
      `Unknown command ${JSON.stringify(command)}. Choose serve, map, live, or install.\n\n${HELP}`,
    );
  }

  const commandModule = await import(moduleUrl.href);
  if (typeof commandModule.run !== "function") {
    throw new CliError(
      `Shape command module ${moduleUrl.pathname} does not export run(args). Reinstall or repair this Shape checkout.`,
      1,
    );
  }

  const result = await commandModule.run(commandArgs);
  if (result === undefined) return 0;
  if (!Number.isInteger(result) || result < 0 || result > 255) {
    throw new CliError(
      `Shape command ${JSON.stringify(command)} returned an invalid exit status. Repair this Shape checkout.`,
      1,
    );
  }
  return result;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;

  try {
    return realpathSync(process.argv[1]) === realpathSync(DISPATCHER_PATH);
  } catch {
    return resolve(process.argv[1]) === resolve(DISPATCHER_PATH);
  }
}

if (isDirectExecution()) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`shape: ${message}`);
    process.exitCode =
      error && typeof error === "object" && Number.isInteger(error.exitCode)
        ? error.exitCode
        : 1;
  }
}
