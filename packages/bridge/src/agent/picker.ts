import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { WatchedProjectCandidate } from "../../../shared/src/index.ts";
import { listWorktrees, projectKey, repoIdentity } from "./worktrees.ts";

interface Chooser {
  command: string;
  args: string[];
}

/**
 * A deterministic stand-in for the native chooser. It is whitespace-split and
 * executed directly, never through a shell; stdout is the selected directory
 * and exit 1 with no stderr means cancel.
 */
function pickerOverride(): Chooser | null {
  const [command, ...args] = (process.env.SHAPE_PICK_FOLDER ?? "")
    .split(/\s+/)
    .filter((part) => part.length > 0);
  return command === undefined ? null : { command, args };
}

const PICKER_OVERRIDE = pickerOverride();

/**
 * macOS directory chooser. A background AppleScript panel opens behind other
 * windows; JXA can temporarily become a regular Cocoa app and raise NSOpenPanel
 * without asking for Finder Automation permission.
 */
const PICK_DIRECTORY_JXA = [
  'ObjC.import("Cocoa"); ObjC.import("stdlib");',
  "const app = $.NSApplication.sharedApplication;",
  "app.setActivationPolicy($.NSApplicationActivationPolicyRegular);",
  "app.activateIgnoringOtherApps(true);",
  "const panel = $.NSOpenPanel.openPanel;",
  "panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false;",
  'panel.message = "Add a watched project to Shape"; panel.prompt = "Add";',
  'panel.directoryURL = $.NSURL.fileURLWithPath($("~").stringByExpandingTildeInPath);',
  "if (panel.runModal !== $.NSModalResponseOK) $.exit(1);",
  "ObjC.unwrap(panel.URLs.objectAtIndex(0).path);",
].join(" ");

function chooser(platform: NodeJS.Platform = process.platform): Chooser | null {
  if (PICKER_OVERRIDE !== null) return PICKER_OVERRIDE;
  if (platform === "darwin") return { command: "osascript", args: ["-l", "JavaScript", "-e", PICK_DIRECTORY_JXA] };
  return null;
}

/** Whether this process can put up a chooser on the repository-owning machine. */
export function directoryPickerAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return chooser(platform) !== null;
}

function runChooser(selected: Chooser, signal?: AbortSignal): Promise<string | null> {
  const { promise, resolve, reject } = Promise.withResolvers<string | null>();
  execFile(selected.command, selected.args, { signal }, (err, stdout, stderr) => {
    if (err === null) {
      const path = stdout.replace(/\r?\n$/, "");
      if (path.length === 0) reject(new Error("directory picker failed: chooser returned no directory"));
      else resolve(path);
      return;
    }
    if (err.name === "AbortError") {
      reject(err);
      return;
    }
    if (err.code === 1 && stderr.trim().length === 0) {
      resolve(null);
      return;
    }
    if (err.code === "ENOENT") {
      reject(new Error(`directory picker unavailable: ${selected.command} could not be run`));
      return;
    }
    const said = stderr.trim().split("\n")[0]?.trim() ?? "";
    reject(new Error(`directory picker failed: ${said.length > 0 ? said : `chooser exited with code ${String(err.code)}`}`));
  });
  return promise;
}

/**
 * Show the native chooser and turn its answer into canonical, read-only Git
 * identity facts. Selection validation deliberately uses strict realpath,
 * stat and access calls; it never uses canonicalDir's ancestor fallback.
 */
export async function pickWatchedProject(signal?: AbortSignal): Promise<WatchedProjectCandidate | null> {
  const selected = chooser();
  if (selected === null) throw new Error(`directory picker unavailable on ${process.platform}`);
  const raw = await runChooser(selected, signal);
  if (raw === null) return null;

  let cwd: string;
  try {
    cwd = await realpath(raw);
    if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
    await access(cwd, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error(`selected directory is not readable: ${raw}`);
  }

  const identity = await repoIdentity(cwd);
  if (identity.commonDir === null) throw new Error(`selected directory is not a Git project: ${cwd}`);
  let main: string;
  try {
    main = await realpath(identity.main);
    await access(main, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error(`selected Git project's main worktree is not readable: ${identity.main}`);
  }
  const listed = await listWorktrees(cwd);
  if (listed.length === 0) throw new Error(`selected directory has no Git worktree: ${cwd}`);
  const worktrees = [...new Map(listed.map((worktree) => [worktree.id, worktree])).values()];

  return {
    key: projectKey(identity),
    label: basename(main),
    cwd: main,
    worktrees,
  };
}
