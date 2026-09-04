/**
 * Starting a brand-new project from the canvas (CONTRACTS.md § create_project):
 * make the folder, put it under version control, optionally publish it to
 * GitHub, and hand back a path the runtime can `switch` onto.
 *
 * The invariant that makes this safe to put behind one button: a new project
 * only ever starts in a folder that has nothing in it. A path that does not
 * exist yet is made; an existing EMPTY directory is used as-is; a folder with
 * so much as one file in it is refused before any git command runs, because
 * `git init` plus `git add -A` in somebody's code directory is not something
 * they can undo by clicking again. Taking up work that is already there is
 * `switch_project`'s job, not this one's.
 *
 * The failure register is otherwise deliberately lopsided. Only "there is
 * nowhere to stand" — a path that exists and is a file, a folder that already
 * holds files, or a folder that cannot be made — is an error; everything after
 * the folder exists (no commit possible, GitHub refusing, an origin already
 * set) comes back as a warning, because the user asked to be moved into a new
 * project and the folder alone already satisfies that. Reporting a warning and
 * landing them there beats refusing the whole request over a missing `gh`
 * login.
 *
 * Every command runs through `execFile` with an argument array: a project path
 * is user text and must never reach a shell.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** what a publish request asks for; null = folder only */
export type GithubRequest = { visibility: "public" | "private" } | null;

export interface CreatedProject {
  /** absolute, resolved path of the new project — what `switch` is given */
  target: string;
  /** whether we put this folder under version control or found it already there */
  repo: "initialized" | "existing";
  github: { url: string } | null;
  /** things the user has to know that did not stop the create */
  warnings: string[];
}

interface Ran {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run a command without a shell; a non-zero exit is data, not an exception. A
 * binary that is not there at all reports nothing on stderr, so the spawn
 * error stands in for it — "gh ENOENT" is the only useful thing to say then.
 */
function run(file: string, args: string[], cwd?: string): Promise<Ran> {
  const { promise, resolve: settle } = Promise.withResolvers<Ran>();
  execFile(file, args, cwd === undefined ? {} : { cwd }, (err, stdout, stderr) => {
    const failed = err === null ? "" : err.message;
    settle({ ok: err === null, stdout, stderr: stderr.trim().length === 0 ? failed : stderr });
  });
  return promise;
}

/** The first line of a tool's complaint is the only part worth a UI line. */
function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ?? "the command failed without saying why";
}

/**
 * Can this machine publish? `gh auth status` exits non-zero both when `gh` is
 * missing and when nobody is signed in, which are the same answer for us: the
 * canvas must not offer a checkbox that cannot work.
 */
export async function probeGitHub(gh: string): Promise<boolean> {
  return (await run(gh, ["auth", "status"])).ok;
}

/**
 * Create the folder at `rawPath` — which must either not exist yet or be an
 * empty directory — and return where to switch.
 * Throws only while there is still nothing to switch onto.
 */
export async function createProject(
  rawPath: string,
  github: GithubRequest,
  opts: { gh: string },
): Promise<CreatedProject> {
  const expanded = rawPath.startsWith("~") ? join(homedir(), rawPath.slice(1)) : rawPath;
  const target = resolve(expanded);

  const existing = await stat(target).catch(() => null);
  if (existing !== null && !existing.isDirectory()) {
    throw new Error(`create_project rejected: "${rawPath}" exists and is not a directory`);
  }
  // an existing folder with anything in it is somebody's work: `git add -A`
  // here would take it over, so this is refused before any git runs
  if (existing !== null && (await readdir(target).catch(() => [])).length > 0) {
    throw new Error(
      `create_project rejected: "${rawPath}" already has files in it — open it with "open another" instead, or choose a new folder name`,
    );
  }
  await mkdir(target, { recursive: true });

  const warnings: string[] = [];
  const name = basename(target);

  // a folder inside an existing repo is not re-initialized: it belongs to that
  // repo's history, and a nested .git would split the project in two
  const inRepo = await run("git", ["-C", target, "rev-parse", "--is-inside-work-tree"]);
  const repo: CreatedProject["repo"] = inRepo.ok ? "existing" : "initialized";

  if (repo === "initialized") {
    const init = await run("git", ["init", "-b", "main"], target);
    if (!init.ok) {
      warnings.push(`could not start version control here: ${firstLine(init.stderr)}`);
    } else {
      // the folder was empty when we got here, so there is nothing to commit
      // unless we write something: a README named after the project
      await writeFile(join(target, "README.md"), `# ${name}\n`, "utf8");
      // exactly the question `git commit` would ask: `git var` answers from
      // config AND the GIT_*_IDENT environment, and fails when git would have
      // to guess an address — which is when a commit refuses to happen
      const identity = await run("git", ["var", "GIT_COMMITTER_IDENT"], target);
      if (!identity.ok || identity.stdout.trim().length === 0) {
        warnings.push(
          "no git identity configured (git config user.name / user.email) — nothing was committed",
        );
      } else {
        const add = await run("git", ["add", "-A"], target);
        const commit = add.ok ? await run("git", ["commit", "-m", "Initial commit"], target) : add;
        if (!commit.ok) warnings.push(`nothing was committed: ${firstLine(commit.stderr)}`);
      }
    }
  }

  let published: { url: string } | null = null;
  if (github !== null) {
    published = await publish(target, name, github.visibility, opts.gh, warnings);
  }

  return { target, repo, github: published, warnings };
}

/**
 * Publish through the `gh` CLI. An origin that already exists wins: re-pointing
 * somebody's remote is not something a "create" may decide. `--push` only when
 * there is a commit to push, otherwise gh fails on an empty repo.
 */
async function publish(
  target: string,
  name: string,
  visibility: "public" | "private",
  gh: string,
  warnings: string[],
): Promise<{ url: string } | null> {
  const origin = await run("git", ["remote", "get-url", "origin"], target);
  if (origin.ok) {
    warnings.push(`already published: ${origin.stdout.trim()}`);
    return null;
  }

  const hasCommit = (await run("git", ["rev-parse", "--verify", "HEAD"], target)).ok;
  const args = ["repo", "create", name, "--source", target, "--remote", "origin", `--${visibility}`];
  if (hasCommit) args.push("--push");

  const created = await run(gh, args, target);
  if (!created.ok) {
    warnings.push(`GitHub: ${firstLine(created.stderr)}`);
    return null;
  }

  const match = /https:\/\/github\.com\/\S+/.exec(created.stdout);
  if (match !== null) return { url: match[0].replace(/[.,)]+$/, "") };
  // gh is free to say nothing useful; the remote it just set is the same answer
  const remote = await run("git", ["remote", "get-url", "origin"], target);
  if (remote.ok && remote.stdout.trim().length > 0) return { url: remote.stdout.trim() };
  warnings.push("GitHub: the repository was created but its address could not be read");
  return null;
}
