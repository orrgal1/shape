/**
 * Infrastructure extraction: what the project's own configuration says about
 * where its code runs and what it leans on outside itself — databases, caches,
 * queues, hosts, pipelines and third-party services.
 *
 * Same discipline as `reality.ts`, for the same reasons:
 * - git decides what exists (the caller's `FileIndex`); a leftover ignored file
 *   is not part of the project, so it can never claim a piece of infrastructure.
 * - nothing is parsed properly. Configuration arrives as YAML, TOML, HCL and
 *   dotenv, and pulling four parsers into the bridge to read a handful of keys
 *   would be a bad trade: the hand parsers below read the shapes that occur in
 *   practice and silently miss anything clever. A miss costs one bubble the
 *   agent has to notice itself; a crash would cost the whole extraction.
 * - every scan is bounded (files read, bytes per file, items produced), so a
 *   pathological repo slows nothing down.
 *
 * The output is mechanical evidence, not a picture: the agent turns these into
 * plain-English infra bubbles during the survey, and anything it never claims
 * stays visible to the user as a ghost.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FileIndex } from "../../../shared/src/fileindex.ts";
import type { NodeKind, RealityInfra } from "../../../shared/src/index.ts";

// ---------------------------------------------------------------------------
// Scan limits
// ---------------------------------------------------------------------------

/** configuration files actually read, in scanner-priority order */
const MAX_CONFIG_FILES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
/** a generic YAML file only gets read as a possible Kubernetes manifest if it is small */
const MAX_MANIFEST_BYTES = 256 * 1024;
/** items produced; a repo that would exceed this has already said plenty */
const MAX_INFRA = 80;
/** evidence files listed per item; the rest are the same story told again */
const MAX_EVIDENCE = 8;

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

/**
 * Which engine a container image, a dependency value or a connection string
 * names. Matched against the whole lowercased string with word boundaries, so
 * `postgres:16`, `bitnami/redis:7` and `postgres://user@host/db` all land.
 * `noun` is what it is in everyday words, for the one-line hint.
 */
const ENGINES: readonly { re: RegExp; name: string; product: string; kind: NodeKind; noun: string }[] = [
  { re: /\b(postgres|postgresql|pgvector|timescaledb)\b/, name: "postgres", product: "Postgres", kind: "database", noun: "database" },
  { re: /\bmariadb\b/, name: "mariadb", product: "MariaDB", kind: "database", noun: "database" },
  { re: /\bmysql\b/, name: "mysql", product: "MySQL", kind: "database", noun: "database" },
  { re: /\b(mongo|mongodb)\b/, name: "mongodb", product: "MongoDB", kind: "database", noun: "database" },
  { re: /\b(redis|valkey)\b/, name: "redis", product: "Redis", kind: "cache", noun: "cache" },
  { re: /\bmemcached\b/, name: "memcached", product: "Memcached", kind: "cache", noun: "cache" },
  { re: /\brabbitmq\b/, name: "rabbitmq", product: "RabbitMQ", kind: "queue", noun: "message queue" },
  { re: /\bkafka\b/, name: "kafka", product: "Kafka", kind: "queue", noun: "message queue" },
  { re: /\bnats\b/, name: "nats", product: "NATS", kind: "queue", noun: "message queue" },
];

/** file name (lowercased basename) -> the platform it configures */
const PLATFORMS: Record<string, string> = {
  "fly.toml": "Fly.io",
  "vercel.json": "Vercel",
  "netlify.toml": "Netlify",
  "render.yaml": "Render",
  "render.yml": "Render",
  "railway.json": "Railway",
  "app.yaml": "Google App Engine",
  procfile: "a Heroku-style host",
  "serverless.yml": "serverless functions",
  "serverless.yaml": "serverless functions",
  "wrangler.toml": "Cloudflare Workers",
};

/**
 * Terraform resource types, matched as substrings of the type in declaration
 * order (so `aws_elasticache_cluster` is a cache before it is an instance).
 * A type no rule matches is not infrastructure we can name, so it is skipped.
 */
const TERRAFORM_KINDS: readonly { re: RegExp; kind: NodeKind }[] = [
  { re: /elasticache|memorystore|redis/, kind: "cache" },
  { re: /cloudfront|cdn/, kind: "cdn" },
  { re: /rds|_db_|_db$|database|dynamodb|spanner|firestore/, kind: "database" },
  { re: /_s3_|s3_bucket|storage_bucket|_bucket/, kind: "store" },
  { re: /sqs|sns|pubsub|kinesis|servicebus/, kind: "queue" },
  { re: /instance|ecs|lambda|cloud_run|app_service|container|kubernetes|compute|droplet|app_runner/, kind: "host" },
];

/** package.json dependency name -> what depending on it proves */
const DEPENDENCY_INFRA: Record<string, { kind: NodeKind; name: string; product: string }> = {
  pg: { kind: "database", name: "postgres", product: "Postgres" },
  postgres: { kind: "database", name: "postgres", product: "Postgres" },
  mysql2: { kind: "database", name: "mysql", product: "MySQL" },
  mongoose: { kind: "database", name: "mongodb", product: "MongoDB" },
  "better-sqlite3": { kind: "database", name: "sqlite", product: "SQLite" },
  prisma: { kind: "database", name: "prisma", product: "Prisma-managed" },
  "@prisma/client": { kind: "database", name: "prisma", product: "Prisma-managed" },
  "drizzle-orm": { kind: "database", name: "drizzle", product: "Drizzle-managed" },
  redis: { kind: "cache", name: "redis", product: "Redis" },
  ioredis: { kind: "cache", name: "redis", product: "Redis" },
  bullmq: { kind: "queue", name: "bullmq", product: "BullMQ" },
  amqplib: { kind: "queue", name: "rabbitmq", product: "RabbitMQ" },
  kafkajs: { kind: "queue", name: "kafka", product: "Kafka" },
  "@aws-sdk/client-s3": { kind: "store", name: "s3", product: "Amazon S3" },
  stripe: { kind: "external", name: "stripe", product: "Stripe" },
  twilio: { kind: "external", name: "twilio", product: "Twilio" },
  sendgrid: { kind: "external", name: "sendgrid", product: "SendGrid" },
  "@sendgrid/mail": { kind: "external", name: "sendgrid", product: "SendGrid" },
  openai: { kind: "external", name: "openai", product: "OpenAI" },
};

/** dependency prefixes, for scoped families whose exact package varies */
const DEPENDENCY_PREFIXES: readonly { prefix: string; kind: NodeKind; name: string; product: string }[] = [
  { prefix: "@anthropic-ai/", kind: "external", name: "anthropic", product: "Anthropic" },
];

/** environment variable names, matched in order against `.env.example` keys */
const ENV_INFRA: readonly { re: RegExp; kind: NodeKind; name: string; product: string }[] = [
  { re: /^POSTGRES_/, kind: "database", name: "postgres", product: "Postgres" },
  { re: /^DATABASE_URL$/, kind: "database", name: "database", product: "A" },
  { re: /^REDIS_URL$/, kind: "cache", name: "redis", product: "Redis" },
  { re: /^(AWS_)?S3_/, kind: "store", name: "s3", product: "Amazon S3" },
];

/** workload kinds that mean "something runs here" in a Kubernetes manifest */
const K8S_WORKLOADS: Record<string, string> = {
  deployment: "Deployment",
  statefulset: "StatefulSet",
  daemonset: "DaemonSet",
  cronjob: "CronJob",
  job: "Job",
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** null = missing, unreadable, or past the byte cap (all "not seen" here) */
async function readTextFile(file: string, maxBytes: number): Promise<string | null> {
  try {
    const buf = await readFile(file);
    if (buf.byteLength > maxBytes) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/** a YAML/TOML scalar as written: quotes off, trailing comment off */
function scalar(raw: string): string {
  let value = raw.trim();
  const hash = value.search(/\s#/);
  if (hash > 0) value = value.slice(0, hash).trim();
  const quote = value.slice(0, 1);
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

/** which engine, if any, this image reference / connection string names */
function engineOf(text: string): (typeof ENGINES)[number] | null {
  const lower = text.toLowerCase();
  return ENGINES.find((engine) => engine.re.test(lower)) ?? null;
}

/**
 * The label a piece of infrastructure carries on the canvas's reality side:
 * what it is, in everyday words, followed by where it was read from. The agent
 * rewrites it into a bubble's own promise; this is the evidence talking.
 */
function labelFor(kind: NodeKind, product: string, where: string): string {
  switch (kind) {
    case "database":
      return `${product} database (${where})`;
    case "cache":
      return `${product} cache (${where})`;
    case "queue":
      return `${product} message queue (${where})`;
    case "store":
      return `${product} file storage (${where})`;
    case "cdn":
      return `${product} content delivery (${where})`;
    case "host":
      return `Runs on ${product} (${where})`;
    case "ci":
      return `${product} pipeline (${where})`;
    case "external":
      return `Uses ${product} (${where})`;
    // no configuration file names a test suite or a review pass, so these only
    // arrive if a future scanner reads one: say what it is and where it was read
    case "ui":
    case "service":
    case "api":
    case "security":
    case "test":
    case "smoke":
    case "check":
    case "review":
    case "monitor":
      return `${product} (${where})`;
  }
}

// ---------------------------------------------------------------------------
// Candidate files
// ---------------------------------------------------------------------------

type FileClass = "compose" | "platform" | "terraform" | "dockerfile" | "workflow" | "package" | "env" | "manifest";

/**
 * Scanner order, and with it the order the file budget is spent: a definite
 * signal (a compose file, a platform config) is read before a maybe (any YAML
 * file that might be a Kubernetes manifest). It is also label precedence —
 * when two files name the same thing, the earlier scanner's label wins and the
 * later one only adds its file to the evidence.
 */
const CLASS_RANK: Record<FileClass, number> = {
  compose: 0,
  platform: 1,
  terraform: 2,
  dockerfile: 3,
  workflow: 4,
  manifest: 5,
  package: 6,
  env: 7,
};

/** null = this file says nothing about infrastructure */
function classify(rel: string): FileClass | null {
  if (rel.includes("node_modules/")) return null;
  const base = (rel.split("/").pop() ?? "").toLowerCase();
  const lower = rel.toLowerCase();

  if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(base)) return "compose";
  if (base in PLATFORMS) return "platform";
  if (base.endsWith(".tf")) return "terraform";
  if (base === "dockerfile" || base.startsWith("dockerfile.") || base.endsWith(".dockerfile")) return "dockerfile";
  if (base === ".gitlab-ci.yml" || base === ".gitlab-ci.yaml") return "workflow";
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(lower)) return "workflow";
  // the rest of .github is repository housekeeping, not infrastructure
  if (lower.startsWith(".github/")) return null;
  if (base === "package.json") return "package";
  if (base === ".env.example" || base === ".env.sample") return "env";
  if (base.endsWith(".yaml") || base.endsWith(".yml")) return "manifest";
  return null;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * One reading of one file. `name` is the dedupe key within a kind — the engine,
 * platform or pipeline itself — so the same database found in a compose file, a
 * dependency and an example environment collapses into one item that carries
 * all three files as evidence.
 */
interface Finding {
  kind: NodeKind;
  name: string;
  label: string;
  hint: string;
  file: string;
  rank: number;
}

// ---------------------------------------------------------------------------
// Scanners
// ---------------------------------------------------------------------------

/**
 * `services:` names and their `image:`, from the two-level shape every compose
 * file in practice has. Anchors, merge keys and flow mappings are not read.
 */
function scanCompose(rel: string, text: string, rank: number, out: Finding[]): void {
  let servicesIndent: number | null = null;
  let serviceIndent: number | null = null;
  let service: string | null = null;

  for (const line of text.split("\n")) {
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    const m = /^(\s*)"?([A-Za-z0-9_.\-/]+)"?\s*:\s*(.*)$/.exec(line);
    if (m === null) continue;
    const [, blanks = "", key = "", rest = ""] = m;
    const indent = blanks.length;
    const value = scalar(rest);

    if (servicesIndent === null) {
      if (key === "services") servicesIndent = indent;
      continue;
    }
    if (indent <= servicesIndent) {
      // a sibling top-level key: the services block is over
      servicesIndent = key === "services" ? indent : null;
      serviceIndent = null;
      service = null;
      continue;
    }
    if (serviceIndent === null || indent === serviceIndent) {
      serviceIndent = indent;
      service = key;
      // a service with no image and no engine is still something that runs
      out.push({
        kind: "host",
        name: `container ${key}`,
        label: `The "${key}" service runs in a container (${rel})`,
        hint: `a container this project runs, read from the service "${key}" in ${rel}`,
        file: rel,
        rank,
      });
      continue;
    }
    if (service === null || key !== "image" || value.length === 0) continue;
    const engine = engineOf(value);
    if (engine === null) continue;
    // an engine image is what the service IS, so its container line is noise
    const container = out.findIndex((f) => f.file === rel && f.name === `container ${service}`);
    if (container >= 0) out.splice(container, 1);
    out.push({
      kind: engine.kind,
      name: engine.name,
      label: labelFor(engine.kind, engine.product, `${rel}: ${service}`),
      hint: `a ${engine.product} ${engine.noun}, read from the service "${service}" in ${rel}`,
      file: rel,
      rank,
    });
  }
}

/**
 * The three classes that are known by their file name alone — a platform
 * config, a Dockerfile, a pipeline definition. Nothing inside them is read:
 * what a pipeline does, or what a Dockerfile builds, is the agent's reading of
 * the file, not ours, and the file is the evidence that sends it there.
 */
function scanByFileName(rel: string, cls: "platform" | "dockerfile" | "workflow", rank: number, out: Finding[]): void {
  const base = (rel.split("/").pop() ?? "").toLowerCase();
  switch (cls) {
    case "platform": {
      const platform = PLATFORMS[base];
      if (platform === undefined) return;
      out.push({
        kind: "host",
        name: platform,
        label: labelFor("host", platform, rel),
        hint: `the project is set up to run on ${platform}, read from ${rel}`,
        file: rel,
        rank,
      });
      return;
    }
    case "dockerfile":
      out.push({
        kind: "host",
        name: `image ${rel}`,
        label: `Runs as a container image it builds itself (${rel})`,
        hint: `a container image this project builds, read from ${rel}`,
        file: rel,
        rank,
      });
      return;
    case "workflow":
      out.push({
        kind: "ci",
        name: `pipeline ${rel}`,
        label: labelFor("ci", /deploy|release|publish|^\.?cd/.test(base) ? "Deployment" : "Build and test", rel),
        hint: `an automated pipeline that runs on every change, read from ${rel}`,
        file: rel,
        rank,
      });
      return;
  }
}

/** `resource "<type>" "<name>"` headers; the bodies are not read */
function scanTerraform(rel: string, text: string, rank: number, out: Finding[]): void {
  const header = /^[ \t]*resource[ \t]+"([^"]+)"[ \t]+"([^"]+)"/gm;
  for (let m = header.exec(text); m !== null; m = header.exec(text)) {
    const [, declared = "", name = ""] = m;
    const type = declared.toLowerCase();
    const mapped = TERRAFORM_KINDS.find((row) => row.re.test(type));
    if (mapped === undefined) continue;
    // the resource address is the evidence; what it is for is the label
    const where = `${rel}: ${type}.${name}`;
    out.push({
      kind: mapped.kind,
      name: `${type} ${name}`,
      label:
        mapped.kind === "host"
          ? `Runs on a declared server (${where})`
          : labelFor(mapped.kind, "Managed", where),
      hint: `declared as the Terraform resource ${type} "${name}" in ${rel}`,
      file: rel,
      rank,
    });
  }
}

/**
 * A Kubernetes workload and the engines its containers run. Documents are split
 * on `---`; `kind:`, `metadata.name` and `image:` are the only keys read.
 */
function scanManifest(rel: string, text: string, rank: number, out: Finding[]): void {
  for (const doc of text.split(/^---\s*$/m)) {
    if (!/^apiVersion\s*:/m.test(doc)) continue;
    const kindLine = /^kind\s*:\s*(.+)$/m.exec(doc);
    if (kindLine === null) continue;
    const workload = K8S_WORKLOADS[scalar(kindLine[1] ?? "").toLowerCase()];
    if (workload === undefined) continue;
    const named = /^metadata\s*:[^\S\n]*\n(?:[ \t]+.*\n)*?[ \t]+name\s*:\s*(.+)$/m.exec(doc);
    const name = named === null ? "" : scalar(named[1] ?? "");
    const where = name.length === 0 ? rel : `${rel}: ${name}`;
    out.push({
      kind: "host",
      name: `kubernetes ${name.length === 0 ? rel : name}`,
      label: `Runs on Kubernetes as ${name.length === 0 ? `a ${workload}` : `"${name}"`} (${where})`,
      hint: `a Kubernetes ${workload}${name.length === 0 ? "" : ` named "${name}"`}, read from ${rel}`,
      file: rel,
      rank,
    });
    const images = /^[ \t]*-?[ \t]*image\s*:\s*(.+)$/gm;
    for (let m = images.exec(doc); m !== null; m = images.exec(doc)) {
      const engine = engineOf(scalar(m[1] ?? ""));
      if (engine === null) continue;
      out.push({
        kind: engine.kind,
        name: engine.name,
        label: labelFor(engine.kind, engine.product, rel),
        hint: `a ${engine.product} ${engine.noun}, read from a container image in ${rel}`,
        file: rel,
        rank,
      });
    }
  }
}

/** `dependencies` keys only: what the code is written against */
function scanPackage(rel: string, text: string, rank: number, out: Finding[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== "object" || !("dependencies" in parsed)) return;
  const deps = parsed.dependencies;
  if (deps === null || typeof deps !== "object") return;

  for (const dep of Object.keys(deps)) {
    const exact = DEPENDENCY_INFRA[dep];
    const matched = exact ?? DEPENDENCY_PREFIXES.find((row) => dep.startsWith(row.prefix));
    if (matched === undefined) continue;
    out.push({
      kind: matched.kind,
      name: matched.name,
      label: labelFor(matched.kind, matched.product, rel),
      hint: `the code depends on "${dep}", read from ${rel}`,
      file: rel,
      rank,
    });
  }
}

/**
 * Keys an example environment expects. The value is read too when it is there:
 * `DATABASE_URL=postgres://…` names its engine, so it joins the database the
 * rest of the configuration already described instead of being a second one.
 */
function scanEnv(rel: string, text: string, rank: number, out: Finding[]): void {
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m === null) continue;
    const [, declared = "", written = ""] = m;
    const key = declared.toUpperCase();
    const matched = ENV_INFRA.find((row) => row.re.test(key));
    if (matched === undefined) continue;
    // a value that names its engine ("postgres://…") is the better reading of
    // the key, and it is the one that joins what the rest of the config said
    const engine = engineOf(scalar(written));
    const read = engine !== null && engine.kind === matched.kind ? engine : matched;
    out.push({
      kind: read.kind,
      name: read.name,
      label: labelFor(read.kind, read.product, `${rel}: ${key}`),
      hint: `the app expects ${key} in its environment, read from ${rel}`,
      file: rel,
      rank,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the project's infrastructure out of its configuration.
 *
 * `index` is the same git file index `extractReality` built, so this sees
 * exactly what git admits. A `null` index means the target is not a git repo:
 * without git there is nothing to tell a real config file from a leftover one,
 * and inventing infrastructure is worse than reporting none, so the answer is
 * an empty list — the same silence the ghost strip shows for a fresh project.
 */
export async function extractInfra(cwd: string, index: FileIndex | null): Promise<RealityInfra[]> {
  if (index === null) return [];
  const root = path.resolve(cwd);

  const candidates: { rel: string; cls: FileClass }[] = [];
  for (const rel of index.files) {
    const cls = classify(rel);
    if (cls !== null) candidates.push({ rel, cls });
  }
  candidates.sort((a, b) => CLASS_RANK[a.cls] - CLASS_RANK[b.cls] || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const findings: Finding[] = [];
  let read = 0;
  for (const { rel, cls } of candidates) {
    if (read >= MAX_CONFIG_FILES) break;
    const rank = CLASS_RANK[cls];
    // these three are known by name alone, so they cost no read at all
    if (cls === "platform" || cls === "dockerfile" || cls === "workflow") {
      scanByFileName(rel, cls, rank, findings);
      continue;
    }
    const text = await readTextFile(
      path.join(root, rel),
      cls === "manifest" ? MAX_MANIFEST_BYTES : MAX_FILE_BYTES,
    );
    if (text === null) continue;
    read++;
    switch (cls) {
      case "compose":
        scanCompose(rel, text, rank, findings);
        break;
      case "terraform":
        scanTerraform(rel, text, rank, findings);
        break;
      case "manifest":
        scanManifest(rel, text, rank, findings);
        break;
      case "package":
        scanPackage(rel, text, rank, findings);
        break;
      case "env":
        scanEnv(rel, text, rank, findings);
        break;
    }
  }

  // one item per (kind, thing): the first scanner to name it writes the label,
  // every later reading only adds its file as further evidence
  const byKey = new Map<string, RealityInfra & { rank: number }>();
  for (const f of findings) {
    const key = `${f.kind}|${f.name}`;
    const seen = byKey.get(key);
    if (seen === undefined) {
      if (byKey.size >= MAX_INFRA) continue;
      byKey.set(key, {
        id: `i:${`${f.kind} ${f.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`,
        label: f.label,
        kind: f.kind,
        evidence: [f.file],
        hint: f.hint,
        rank: f.rank,
      });
      continue;
    }
    if (f.rank < seen.rank) {
      seen.label = f.label;
      seen.hint = f.hint;
      seen.rank = f.rank;
    }
    if (!seen.evidence.includes(f.file) && seen.evidence.length < MAX_EVIDENCE) seen.evidence.push(f.file);
  }

  return [...byKey.values()]
    .map(({ rank: _rank, ...item }) => ({ ...item, evidence: [...item.evidence].sort() }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}
