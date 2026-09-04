#!/usr/bin/env node
/**
 * A `gh` stand-in for the smoke: `SHAPE_GH` points the agent at this file so
 * publishing a new project is exercised end to end without touching a real
 * GitHub account.
 *
 *   auth status            -> exit 0 (this machine "can publish")
 *   repo create <name> ... -> prints a fake https URL, exit 0
 *   anything else          -> exit 1
 *
 * Every invocation's argv is appended to $FAKE_GH_LOG as one JSON line, so a
 * test can assert which flags the agent chose (--private, --push, ...).
 */

import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const log = process.env.FAKE_GH_LOG;
if (log !== undefined) appendFileSync(log, `${JSON.stringify(argv)}\n`);

if (argv[0] === "auth" && argv[1] === "status") {
  console.log("Logged in to github.com as fake (FAKE_GH)");
  process.exit(0);
}

if (argv[0] === "repo" && argv[1] === "create" && typeof argv[2] === "string") {
  console.log(`https://github.com/fake/${argv[2]}`);
  process.exit(0);
}

console.error(`fake-gh: unsupported command: ${argv.join(" ")}`);
process.exit(1);
