import { constants, realpathSync, statSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const HEALTH_BODY = Buffer.from(JSON.stringify({ service: "shape", protocolVersion: 1 }));
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

class BadPathError extends Error {}

function requestPath(request: IncomingMessage): string {
  const target = request.url ?? "/";
  const query = target.indexOf("?");
  const rawPath = query === -1 ? target : target.slice(0, query);
  if (!rawPath.startsWith("/")) throw new BadPathError();

  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    throw new BadPathError();
  }
  if (path.includes("\\") || path.includes("\0")) throw new BadPathError();
  if (path.split("/").some((part) => part === "." || part === ".." || part.startsWith("."))) {
    throw new BadPathError();
  }
  return path;
}

function reply(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: string,
  allow?: string,
): void {
  const bytes = Buffer.from(body);
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("content-length", bytes.byteLength);
  response.setHeader("x-content-type-options", "nosniff");
  if (allow !== undefined) response.setHeader("allow", allow);
  response.end(request.method === "HEAD" ? undefined : bytes);
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function cacheControl(path: string, extension: string): string {
  if (extension === ".html" || extension === "") return "no-cache";
  const filename = path.slice(path.lastIndexOf("/") + 1);
  if (/[.-][A-Za-z0-9_-]{8,}\.[^.]+$/.test(filename)) return "public, max-age=31536000, immutable";
  return "public, max-age=300";
}

async function canonicalFile(root: string, path: string): Promise<string | null> {
  let target: string;
  try {
    target = await realpath(resolve(root, `.${path}`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
  if (!isInside(root, target)) throw new BadPathError();
  return (await stat(target)).isFile() ? target : null;
}

function canonicalRoot(webDir: string): string {
  const root = realpathSync(resolve(webDir));
  if (!statSync(root).isDirectory()) throw new Error("web root is not a directory");
  return root;
}

async function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: string,
  requestPathname: string,
): Promise<void> {
  // Open the canonical target without following a replacement final symlink;
  // keep this descriptor through the response so a path swap cannot change
  // which bytes are served after the containment check.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      reply(request, response, 404, "not found\n");
      return;
    }
    const extension = extname(file).toLowerCase();
    response.statusCode = 200;
    response.setHeader("content-type", MIME_TYPES[extension] ?? "application/octet-stream");
    response.setHeader("content-length", info.size);
    response.setHeader("cache-control", cacheControl(requestPathname, extname(requestPathname).toLowerCase()));
    response.setHeader("x-content-type-options", "nosniff");
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    await pipeline(handle.createReadStream({ autoClose: false }), response);
  } finally {
    await handle.close();
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  isWebSocketPath: (path: string) => boolean,
): Promise<void> {
  const path = requestPath(request);
  if (isWebSocketPath(path)) {
    reply(request, response, 426, "websocket upgrade required\n");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    reply(request, response, 405, "method not allowed\n", "GET, HEAD");
    return;
  }
  if (path === "/api/health") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("content-length", HEALTH_BODY.byteLength);
    response.setHeader("cache-control", "no-cache");
    response.setHeader("x-content-type-options", "nosniff");
    response.end(request.method === "HEAD" ? undefined : HEALTH_BODY);
    return;
  }

  const webRoot = root;
  let file = await canonicalFile(webRoot, path);
  if (file === null && (path === "/" || extname(path) === "")) {
    file = await canonicalFile(webRoot, "/index.html");
  }
  if (file === null) {
    reply(request, response, 404, "not found\n");
    return;
  }
  await serveFile(request, response, file, path);
}

export function createHttpHandler(
  webDir: string,
  isWebSocketPath: (path: string) => boolean,
): (request: IncomingMessage, response: ServerResponse) => void {
  const root = canonicalRoot(webDir);
  return (request, response) => {
    void handleRequest(request, response, root, isWebSocketPath).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (error instanceof BadPathError) {
        reply(request, response, 400, "bad request\n");
        return;
      }
      reply(request, response, 500, "internal server error\n");
    });
  };
}
