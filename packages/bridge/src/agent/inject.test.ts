/**
 * Tests for the injection pass: the one part of Shape that TYPES INTO the
 * user's live sessions. Everything it can get wrong is something the user
 * would feel immediately — a directive pasted into a working agent twice, a
 * pane briefed that the manager does not own, a manager told "your builders are
 * covered" before the config that covers them was written, or one dead pane
 * taking the whole round down with it — so each of those is a case here.
 *
 * The seams are the two the module actually depends on: a fake `mgr` (a shell
 * script that reads board and config JSON out of a temp dir and logs every
 * invocation, so the ORDER of writes against the prompt is observable) and a
 * fake launcher (two async functions, which is all `InjectLauncher` is). No
 * herdr, no real `mgr`, no session is touched.
 *
 * Run (Node 26 type-stripping, no runner, no deps):
 *   node --test packages/bridge/src/agent/inject.test.ts
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { INJECT_MANAGER_LINE, INJECT_PREFIX, type InjectLauncher, injectProject } from "./inject.ts";
import { OMP_EXTENSION, type ManagerEnvironment } from "./manager.ts";

const LINK = "ws://127.0.0.1:1/link";

/** what the fake `mgr` is: board and config out of files, every call logged */
const MGR_SCRIPT = (dir: string) => `#!/bin/sh
dir='${dir}'
printf '%s\\t%s\\n' "$HERDR_WORKSPACE_ID" "$*" >> "$dir/mgr.log"
printf '[%s]\\n' "$HERDR_PANE_ID" >> "$dir/pane.log"
if [ "$1" = "board" ]; then
  [ -f "$dir/board-$HERDR_WORKSPACE_ID.json" ] || exit 1
  cat "$dir/board-$HERDR_WORKSPACE_ID.json"
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "list" ]; then
  if [ -f "$dir/config-$HERDR_WORKSPACE_ID.json" ]; then
    cat "$dir/config-$HERDR_WORKSPACE_ID.json"
  else
    echo '{}'
  fi
fi
exit 0
`;

interface Prompted {
  paneId: string;
  text: string;
  /** the `mgr` log as it stood WHEN this prompt arrived: ordering, observed */
  log: string;
}

interface Harness {
  dir: string;
  /** two real directories, because `mgr` is spawned with them as its cwd */
  project: { path: string; label: string };
  projectB: { path: string; label: string };
  env: ManagerEnvironment;
  launcher: InjectLauncher;
  prompts: Prompted[];
  linked: Set<string>;
  refuse: Set<string>;
  workspaces: Map<string, string>;
  directive: string;
  directivePath: string;
  board(workspaceId: string, board: unknown): Promise<void>;
  config(workspaceId: string, config: unknown): Promise<void>;
  log(): Promise<string>;
  paneLog(): Promise<string>;
}

async function harness(t: TestContext): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "shape-inject-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const project = { path: join(dir, "primary"), label: "shape" };
  const projectB = { path: join(dir, "other"), label: "other" };
  await mkdir(project.path);
  await mkdir(projectB.path);

  const mgr = join(dir, "mgr");
  await writeFile(mgr, MGR_SCRIPT(dir));
  await chmod(mgr, 0o755);

  const directive = "# Shape\n\nDial SHAPE_LINK and report what you are doing.\n";
  const directivePath = join(dir, "shape-directive.md");
  await writeFile(directivePath, directive);

  const linked = new Set<string>();
  const refuse = new Set<string>();
  const prompts: Prompted[] = [];
  const workspaces = new Map<string, string>([
    [project.path, "ws-a"],
    [projectB.path, "ws-b"],
  ]);

  const log = () => readFile(join(dir, "mgr.log"), "utf8").catch(() => "");

  return {
    dir,
    project,
    projectB,
    env: {
      linkUrl: LINK,
      directivePath,
      isLinked: (cwd) => linked.has(cwd),
      mgr,
    },
    launcher: {
      workspaceOf: async (p) => workspaces.get(p.path) ?? null,
      prompt: async (paneId, text) => {
        prompts.push({ paneId, text, log: await log() });
        if (refuse.has(paneId)) throw new Error("herdr refused: pane_not_found (no such pane)");
      },
    },
    prompts,
    linked,
    refuse,
    workspaces,
    directive,
    directivePath,
    board: (workspaceId, board) => writeFile(join(dir, `board-${workspaceId}.json`), `${JSON.stringify(board)}\n`),
    config: (workspaceId, config) => writeFile(join(dir, `config-${workspaceId}.json`), `${JSON.stringify(config)}\n`),
    log,
    paneLog: () => readFile(join(dir, "pane.log"), "utf8").catch(() => ""),
  };
}

/** the shape of an `in_flight` row, with only the fields injection reads */
function issue(number: number, paneId: string | null, worktree: string | null): Record<string, unknown> {
  return { number, title: `issue ${number}`, state: "in_flight", pane_id: paneId, worktree, branch: `issue-${number}` };
}

test("a pane already on the link is not prompted", async (t) => {
  const h = await harness(t);
  const worktree = join(h.dir, "wt-5");
  await h.board("ws-a", { manager: null, in_flight: [issue(5, "pane-5", worktree)], awaiting_approval: [], adopting: [] });
  h.linked.add(worktree);

  const briefed = new Set<string>();
  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, briefed), []);
  assert.deepEqual(h.prompts, []);
  assert.equal(briefed.size, 0);
});

test("an unlinked builder is prompted exactly once, ever", async (t) => {
  const h = await harness(t);
  await h.board("ws-a", {
    manager: null,
    in_flight: [issue(7, "pane-7", join(h.dir, "wt-7"))],
    awaiting_approval: [],
    adopting: [],
  });

  const briefed = new Set<string>();
  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, briefed), ["pane-7"]);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0]?.paneId, "pane-7");
  assert.equal(h.prompts[0]?.text, `${INJECT_PREFIX}\n\n${h.directive}`);
  assert.ok(briefed.has("pane-7"));

  // the scan loop comes back in seconds; the same board must now be a no-op
  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, briefed), []);
  assert.equal(h.prompts.length, 1);
});

test("an awaiting_approval row and an adopting pane are both the manager's business", async (t) => {
  const h = await harness(t);
  await h.board("ws-a", {
    manager: null,
    in_flight: [],
    awaiting_approval: [issue(8, "pane-8", join(h.dir, "wt-8"))],
    adopting: [{ pane_id: "pane-9", tab_id: "tab-9", agent: "omp", agent_status: "busy", cwd: join(h.dir, "wt-9") }],
    unmanaged: [{ pane_id: "pane-shell", cwd: h.project.path }],
  });

  const briefed = new Set<string>();
  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, briefed), ["pane-8", "pane-9"]);
  // `unmanaged` is the manager's own business, and Shape types into none of it
  assert.deepEqual(
    h.prompts.map((entry) => entry.paneId),
    ["pane-8", "pane-9"],
  );
});

test("an unaware manager is configured first, then told its builders are covered", async (t) => {
  const h = await harness(t);
  await h.board("ws-a", {
    manager: { pane_id: "pane-mgr", tab_id: "tab-1", agent: "omp", cwd: h.project.path },
    in_flight: [],
    awaiting_approval: [],
    adopting: [],
  });

  const briefed = new Set<string>();
  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, briefed), ["pane-mgr"]);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0]?.text, `${INJECT_PREFIX}\n${INJECT_MANAGER_LINE}\n\n${h.directive}`);

  // every key `mgr config` needs, and all of it written BEFORE the sentence
  // claiming it was written reached the pane
  const atPrompt = h.prompts[0]?.log ?? "";
  for (const call of [
    "config list",
    "config unset omp-arg",
    "config add omp-arg --extension",
    `config add omp-arg ${OMP_EXTENSION}`,
    "config unset env",
    `config add env SHAPE_LINK=${LINK}`,
    `config set brief-extra ${h.directivePath}`,
  ]) {
    assert.ok(atPrompt.includes(`ws-a\t${call}`), `${call} must precede the prompt; log was:\n${atPrompt}`);
  }
});

test("a manager whose config already names this Shape is prompted without a single write", async (t) => {
  const h = await harness(t);
  await h.board("ws-a", {
    manager: { pane_id: "pane-mgr", tab_id: "tab-1", agent: "omp", cwd: h.project.path },
    in_flight: [],
    awaiting_approval: [],
    adopting: [],
  });
  await h.config("ws-a", {
    "omp-arg": ["--extension", OMP_EXTENSION],
    env: [`SHAPE_LINK=${LINK}`],
    "brief-extra": h.directivePath,
  });

  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, new Set<string>()), ["pane-mgr"]);
  assert.equal(h.prompts.length, 1);
  const lines = (await h.log()).trim().split("\n");
  assert.deepEqual(lines, ["ws-a\tboard", "ws-a\tconfig list"]);
});

test("a manager already on the link is neither prompted nor configured", async (t) => {
  const h = await harness(t);
  await h.board("ws-a", {
    manager: { pane_id: "pane-mgr", tab_id: "tab-1", agent: "omp", cwd: h.project.path },
    in_flight: [],
    awaiting_approval: [],
    adopting: [],
  });
  h.linked.add(h.project.path);

  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, new Set<string>()), []);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual((await h.log()).trim().split("\n"), ["ws-a\tboard"]);
});

test("one pane refusing the directive does not stop the others, and is retried", async (t) => {
  const h = await harness(t);
  await h.board("ws-a", {
    manager: null,
    in_flight: [issue(1, "pane-1", join(h.dir, "wt-1")), issue(2, "pane-2", join(h.dir, "wt-2"))],
    awaiting_approval: [issue(3, "pane-3", join(h.dir, "wt-3"))],
    adopting: [],
  });
  h.refuse.add("pane-2");

  const briefed = new Set<string>();
  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, briefed), ["pane-1", "pane-3"]);
  assert.deepEqual([...briefed].sort(), ["pane-1", "pane-3"]);

  // the refusal was transient (the agent was mid-tool); the next scan retries
  // exactly the pane that never took it
  h.refuse.clear();
  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, briefed), ["pane-2"]);
  assert.deepEqual(
    h.prompts.map((entry) => entry.paneId),
    ["pane-1", "pane-2", "pane-3", "pane-2"],
  );
  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, briefed), []);
});

test("two projects are briefed independently, and a shared pane only once", async (t) => {
  const h = await harness(t);
  await h.board("ws-a", {
    manager: null,
    in_flight: [issue(1, "pane-x", join(h.dir, "wt-x")), issue(2, "pane-shared", join(h.dir, "wt-shared"))],
    awaiting_approval: [],
    adopting: [],
  });
  await h.board("ws-b", {
    manager: null,
    in_flight: [issue(4, "pane-shared", join(h.dir, "wt-shared")), issue(5, "pane-y", join(h.dir, "wt-y"))],
    awaiting_approval: [],
    adopting: [],
  });

  // one process, one set: a pane is briefed once no matter which board sees it
  const briefed = new Set<string>();
  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, briefed), ["pane-shared", "pane-x"]);
  assert.deepEqual(await injectProject(h.projectB, h.launcher, h.env, briefed), ["pane-y"]);
  assert.deepEqual(
    h.prompts.map((entry) => entry.paneId),
    ["pane-shared", "pane-x", "pane-y"],
  );
  const workspacesCalled = (await h.log())
    .trim()
    .split("\n")
    .map((line) => line.split("\t")[0]);
  assert.deepEqual(workspacesCalled, ["ws-a", "ws-b"]);
});

test("two passes running at once, as the fleet runs them, still brief a shared pane once", async (t) => {
  const h = await harness(t);
  // two repos in ONE herdr workspace put the same pane on both boards; the
  // fleet starts every project's pass together, so both read `briefed` before
  // either has typed anything — the reservation is what makes "once" hold
  const shared = { manager: null, in_flight: [issue(2, "pane-shared", join(h.dir, "wt-shared"))], awaiting_approval: [], adopting: [] };
  await h.board("ws-a", shared);
  await h.board("ws-b", shared);

  const briefed = new Set<string>();
  const [a, b] = await Promise.all([
    injectProject(h.project, h.launcher, h.env, briefed),
    injectProject(h.projectB, h.launcher, h.env, briefed),
  ]);
  assert.deepEqual([...a, ...b], ["pane-shared"]);
  assert.deepEqual(
    h.prompts.map((entry) => entry.paneId),
    ["pane-shared"],
  );
  assert.deepEqual([...briefed], ["pane-shared"]);
});

test("a refused pane gives its reservation back, so a refusal never blocks a later pass", async (t) => {
  const h = await harness(t);
  await h.board("ws-a", { manager: null, in_flight: [issue(1, "pane-1", join(h.dir, "wt-1"))], awaiting_approval: [], adopting: [] });
  h.refuse.add("pane-1");

  const briefed = new Set<string>();
  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, briefed), []);
  assert.deepEqual([...briefed], []);
});

test("a project with no herdr workspace is left alone entirely", async (t) => {
  const h = await harness(t);
  h.workspaces.delete(h.project.path);

  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, new Set<string>()), []);
  assert.deepEqual(h.prompts, []);
  assert.equal(await h.log(), "");
});

test("no directive yet means nothing is typed anywhere", async (t) => {
  const h = await harness(t);
  await h.board("ws-a", {
    manager: null,
    in_flight: [issue(7, "pane-7", join(h.dir, "wt-7"))],
    awaiting_approval: [],
    adopting: [],
  });

  const env = { ...h.env, directivePath: null };
  assert.deepEqual(await injectProject(h.project, h.launcher, env, new Set<string>()), []);
  assert.deepEqual(h.prompts, []);
});

test("a mgr board that failed skips the project this round, briefing nobody", async (t) => {
  const h = await harness(t);
  // no board file for ws-a at all: the fake `mgr` exits non-zero, as the real
  // one does in a repo the skill is not set up in
  const briefed = new Set<string>();
  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, briefed), []);
  assert.deepEqual(h.prompts, []);
  assert.equal(briefed.size, 0);

  // and the next scan, with a board, briefs normally
  await h.board("ws-a", {
    manager: null,
    in_flight: [issue(7, "pane-7", join(h.dir, "wt-7"))],
    awaiting_approval: [],
    adopting: [],
  });
  assert.deepEqual(await injectProject(h.project, h.launcher, h.env, briefed), ["pane-7"]);
});

test("mgr never sees a pane id, so a bridge inside a herdr pane cannot register as manager", async (t) => {
  const h = await harness(t);
  await h.board("ws-a", {
    manager: { pane_id: "pane-mgr", tab_id: "tab-1", agent: "omp", cwd: h.project.path },
    in_flight: [],
    awaiting_approval: [],
    adopting: [],
  });

  // the bridge was started from a herdr pane and inherited its id; `mgr`
  // heartbeats the guard whenever it sees both variables
  const had = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = "pane-bridge";
  t.after(() => {
    if (had === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = had;
  });

  await injectProject(h.project, h.launcher, h.env, new Set<string>());
  const seen = (await h.paneLog()).trim().split("\n");
  assert.ok(seen.length > 0);
  assert.deepEqual([...new Set(seen)], ["[]"]);
});
