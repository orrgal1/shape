import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALLER_OWNER = "shape.skill-installer";
const MANIFEST_NAME = ".shape-skill-owner.json";
const MANIFEST_VERSION = 1;
const DISPATCHER_TOKEN = "__SHAPE_DISPATCHER_JSON__";
const SKILLS = Object.freeze(["shape-serve", "shape-map", "shape-live"]);
const STANDARD_TARGETS = new Set(["all", "omp", "claude"]);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CHECKOUT_ROOT = resolve(MODULE_DIR, "../..");
const DISPATCHER_PATH = resolve(CHECKOUT_ROOT, "scripts/shape.mjs");

const HELP = `Install Shape harness skills

Usage:
  shape install [all|omp|claude] [--custom-dir <path>]

Targets:
  shape install
  shape install all
      Install into both $HOME/.omp/agent/skills and $HOME/.claude/skills.

  shape install omp
  shape install claude
      Install only for the selected harness.

  shape install --custom-dir <path>
      Install only into an explicit skill directory for another harness.

  shape install all --custom-dir <path>
      Install into both standard harnesses and the explicit directory.

The installer copies skill files (it does not rely on symlinks), records ownership by
checkout, and only updates an installation owned by this same Shape checkout.`;

class InstallError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstallError";
    this.exitCode = 2;
  }
}

function configuredHome() {
  const fromEnvironment = process.env.HOME?.trim();
  return resolve(fromEnvironment || homedir());
}

function expandHome(input) {
  const home = configuredHome();
  if (input === "~" || input === "$HOME" || input === "${HOME}") return home;
  if (input.startsWith(`~${sep}`)) return join(home, input.slice(2));
  if (input.startsWith("$HOME/")) return join(home, input.slice(6));
  if (input.startsWith("${HOME}/")) return join(home, input.slice(8));
  if (input.startsWith("~")) {
    throw new InstallError(
      `Unsupported home path ${JSON.stringify(input)}. Use ~, $HOME, or an absolute path; named-user expansion is not supported.`,
    );
  }
  return resolve(input);
}

function parseArgs(args) {
  let standardTarget;
  const customDirectories = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--help" || argument === "-h") {
      return { help: true, roots: [] };
    }

    if (argument === "--custom-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new InstallError(
          "--custom-dir requires a skill directory path. Example: shape install --custom-dir ~/my-harness/skills",
        );
      }
      customDirectories.push(expandHome(value));
      index += 1;
      continue;
    }

    if (argument.startsWith("--custom-dir=")) {
      const value = argument.slice("--custom-dir=".length);
      if (!value) {
        throw new InstallError(
          "--custom-dir requires a skill directory path. Example: shape install --custom-dir ~/my-harness/skills",
        );
      }
      customDirectories.push(expandHome(value));
      continue;
    }

    if (argument.startsWith("-")) {
      throw new InstallError(
        `Unknown install option ${JSON.stringify(argument)}. Run shape install --help for supported targets and options.`,
      );
    }

    if (!STANDARD_TARGETS.has(argument)) {
      throw new InstallError(
        `Unknown install target ${JSON.stringify(argument)}. Choose all, omp, claude, or use --custom-dir <path>.`,
      );
    }
    if (standardTarget) {
      throw new InstallError(
        `Only one standard install target is allowed; received ${JSON.stringify(standardTarget)} and ${JSON.stringify(argument)}.`,
      );
    }
    standardTarget = argument;
  }

  const roots = [];
  if (standardTarget || customDirectories.length === 0) {
    const target = standardTarget || "all";
    const home = configuredHome();
    if (target === "all" || target === "omp") {
      roots.push({ label: "OMP", path: join(home, ".omp", "agent", "skills") });
    }
    if (target === "all" || target === "claude") {
      roots.push({ label: "Claude", path: join(home, ".claude", "skills") });
    }
  }
  for (const path of customDirectories) {
    roots.push({ label: "custom", path });
  }

  return { help: false, roots };
}

function digest(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function statOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isSafeManagedPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !isAbsolute(path) &&
    normalize(path) === path &&
    path !== ".." &&
    !path.startsWith(`..${sep}`)
  );
}

async function readManifest(skillDirectory) {
  const manifestPath = join(skillDirectory, MANIFEST_NAME);
  const manifestStat = await statOrNull(manifestPath);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) return null;

  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function isOwnedManifest(manifest, checkoutRoot, skill) {
  return (
    manifest?.schemaVersion === MANIFEST_VERSION &&
    manifest?.owner === INSTALLER_OWNER &&
    manifest?.checkout === checkoutRoot &&
    manifest?.skill === skill &&
    manifest?.files &&
    typeof manifest.files === "object" &&
    !Array.isArray(manifest.files) &&
    Object.keys(manifest.files).length === 1 &&
    Object.hasOwn(manifest.files, "SKILL.md") &&
    Object.keys(manifest.files).every(isSafeManagedPath) &&
    Object.values(manifest.files).every(
      (value) => typeof value === "string" && value.startsWith("sha256:"),
    )
  );
}

async function verifyManagedFiles(skillDirectory, manifest) {
  for (const [managedPath, expectedDigest] of Object.entries(manifest.files)) {
    const absolutePath = join(skillDirectory, managedPath);
    const fileStat = await statOrNull(absolutePath);
    if (!fileStat?.isFile() || fileStat.isSymbolicLink()) return false;
    if (digest(await readFile(absolutePath)) !== expectedDigest) return false;
  }
  return true;
}

function conflictMessage(skillDirectory, detail) {
  return `Refusing to replace ${skillDirectory}: ${detail}. Move or remove that same-name skill directory, then rerun shape install.`;
}

async function inspectInstallation(root, skill, checkoutRoot, desiredDigest) {
  const skillDirectory = join(root, skill);
  const targetStat = await statOrNull(skillDirectory);
  if (!targetStat) return { skillDirectory, exists: false, current: false };
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new InstallError(
      conflictMessage(skillDirectory, "it is not a directory owned by this Shape checkout"),
    );
  }

  const manifest = await readManifest(skillDirectory);
  if (!isOwnedManifest(manifest, checkoutRoot, skill)) {
    const ownerDetail =
      manifest?.owner === INSTALLER_OWNER && manifest?.checkout
        ? `it belongs to a different Shape checkout (${manifest.checkout})`
        : "it has no valid ownership manifest for this Shape checkout";
    throw new InstallError(conflictMessage(skillDirectory, ownerDetail));
  }
  if (!(await verifyManagedFiles(skillDirectory, manifest))) {
    throw new InstallError(
      conflictMessage(
        skillDirectory,
        "a managed file was changed or removed after installation; preserve those edits elsewhere first",
      ),
    );
  }

  return {
    skillDirectory,
    exists: true,
    current: manifest.files["SKILL.md"] === desiredDigest,
    manifest,
  };
}

async function atomicWrite(path, content) {
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { flag: "wx", mode: 0o644 });
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

async function loadTemplates(dispatcherPath) {
  const dispatcherArgument = JSON.stringify(dispatcherPath);
  const templates = new Map();

  for (const skill of SKILLS) {
    const templatePath = join(CHECKOUT_ROOT, "skills", skill, "SKILL.md");
    let source;
    try {
      source = await readFile(templatePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new InstallError(
          `Missing skill template ${templatePath}. Restore the complete Shape checkout, then rerun shape install.`,
        );
      }
      throw error;
    }

    if (!source.includes(DISPATCHER_TOKEN)) {
      throw new InstallError(
        `Skill template ${templatePath} is missing ${DISPATCHER_TOKEN}. Repair the Shape checkout before installing.`,
      );
    }

    const rendered = source.replaceAll(DISPATCHER_TOKEN, () => dispatcherArgument);
    if (rendered.includes(DISPATCHER_TOKEN) || !rendered.includes(dispatcherArgument)) {
      throw new InstallError(
        `Could not safely materialize the absolute Shape dispatcher path in ${templatePath}. Repair the template before installing.`,
      );
    }
    templates.set(skill, rendered);
  }

  return templates;
}

function manifestFor(checkoutRoot, skill, skillContent) {
  return {
    schemaVersion: MANIFEST_VERSION,
    owner: INSTALLER_OWNER,
    checkout: checkoutRoot,
    skill,
    files: { "SKILL.md": digest(skillContent) },
  };
}

async function installSkill(inspection, checkoutRoot, skill, content) {
  const manifestContent = `${JSON.stringify(manifestFor(checkoutRoot, skill, content), null, 2)}\n`;
  const skillPath = join(inspection.skillDirectory, "SKILL.md");
  const manifestPath = join(inspection.skillDirectory, MANIFEST_NAME);

  if (!inspection.exists) {
    await mkdir(inspection.skillDirectory);
    try {
      await atomicWrite(skillPath, content);
      await atomicWrite(manifestPath, manifestContent);
    } catch (error) {
      for (const path of [skillPath, manifestPath]) {
        try {
          await unlink(path);
        } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") throw cleanupError;
        }
      }
      try {
        await rmdir(inspection.skillDirectory);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT" && cleanupError?.code !== "ENOTEMPTY") {
          throw cleanupError;
        }
      }
      throw error;
    }
    return "installed";
  }

  if (inspection.current) return "current";

  const previousSkill = await readFile(skillPath);
  const previousManifest = await readFile(manifestPath);
  try {
    await atomicWrite(skillPath, content);
    await atomicWrite(manifestPath, manifestContent);
  } catch (error) {
    await atomicWrite(skillPath, previousSkill);
    await atomicWrite(manifestPath, previousManifest);
    throw error;
  }
  return "updated";
}

async function cleanOwnedLegacyVisualize(root, checkoutRoot) {
  const legacyDirectory = join(root, "visualize");
  const legacyStat = await statOrNull(legacyDirectory);
  if (!legacyStat) return null;

  if (legacyStat.isSymbolicLink()) {
    const sourceDirectory = join(checkoutRoot, "skills", "visualize");
    let sourceRealPath;
    let linkRealPath;
    try {
      sourceRealPath = await realpath(sourceDirectory);
      linkRealPath = await realpath(legacyDirectory);
    } catch {
      const linkTarget = await readlink(legacyDirectory);
      sourceRealPath = resolve(sourceDirectory);
      linkRealPath = resolve(dirname(legacyDirectory), linkTarget);
    }
    if (linkRealPath !== sourceRealPath) return null;
    await unlink(legacyDirectory);
    return "removed";
  }

  if (!legacyStat.isDirectory()) return null;
  const manifest = await readManifest(legacyDirectory);
  if (!isOwnedManifest(manifest, checkoutRoot, "visualize")) return null;
  if (!(await verifyManagedFiles(legacyDirectory, manifest))) return "modified";

  for (const managedPath of Object.keys(manifest.files)) {
    await unlink(join(legacyDirectory, managedPath));
  }
  await unlink(join(legacyDirectory, MANIFEST_NAME));
  try {
    await rmdir(legacyDirectory);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY") throw error;
  }
  return "removed";
}

export async function run(args = []) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const checkoutRoot = await realpath(CHECKOUT_ROOT);
  const dispatcherPath = await realpath(DISPATCHER_PATH);
  const templates = await loadTemplates(dispatcherPath);

  const rootsByRealPath = new Map();
  for (const root of options.roots) {
    await mkdir(root.path, { recursive: true });
    const rootRealPath = await realpath(root.path);
    const existing = rootsByRealPath.get(rootRealPath);
    if (existing) {
      existing.label = `${existing.label}/${root.label}`;
    } else {
      rootsByRealPath.set(rootRealPath, { label: root.label, path: rootRealPath });
    }
  }
  const roots = [...rootsByRealPath.values()];

  const plans = [];
  for (const root of roots) {
    const inspections = new Map();
    for (const skill of SKILLS) {
      const content = templates.get(skill);
      inspections.set(
        skill,
        await inspectInstallation(root.path, skill, checkoutRoot, digest(content)),
      );
    }
    plans.push({ root, inspections });
  }

  for (const { root, inspections } of plans) {
    const statuses = [];
    for (const skill of SKILLS) {
      statuses.push(
        await installSkill(inspections.get(skill), checkoutRoot, skill, templates.get(skill)),
      );
    }

    const legacyStatus = await cleanOwnedLegacyVisualize(root.path, checkoutRoot);
    const changed = statuses.some((status) => status !== "current");
    const verb = changed ? "Installed/updated" : "Already current";
    console.log(`${verb} ${SKILLS.join(", ")} in ${root.label}: ${root.path}`);
    if (legacyStatus === "removed") {
      console.log(`Removed the legacy visualize skill owned by this checkout from ${root.path}.`);
    } else if (legacyStatus === "modified") {
      console.warn(
        `Preserved ${join(root.path, "visualize")} because its managed files were modified; review and remove it manually if obsolete.`,
      );
    }
  }

  return 0;
}
