#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";

const stateFile = process.argv[2];
if (stateFile === undefined) process.exit(2);

const choices = JSON.parse(await readFile(stateFile, "utf8"));
const choice = choices.shift();
await writeFile(stateFile, JSON.stringify(choices));

if (
  choice !== null &&
  typeof choice === "object" &&
  typeof choice.hang === "string"
) {
  await appendFile(choice.hang, "started\n");
  process.on("SIGTERM", () => {
    void appendFile(choice.hang, "terminated\n").finally(() => process.exit(0));
  });
  await new Promise(() => {});
}
if (choice === null) process.exit(1);
if (typeof choice !== "string") process.exit(2);
process.stdout.write(`${choice}\n`);
