#!/usr/bin/env node

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const rootDir = path.resolve(process.env.STATIC_ROOT ?? path.join(process.cwd(), "dist"));

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function isInsideRoot(filePath) {
  const relativePath = path.relative(rootDir, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function resolvePathname(pathname) {
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  if (segments.some((segment) => segment === "..")) {
    return null;
  }

  return path.resolve(rootDir, ...segments);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveFile(pathname) {
  const candidate = resolvePathname(pathname);

  if (!candidate || !isInsideRoot(candidate)) {
    return { statusCode: 403 };
  }

  let filePath = candidate;

  if (pathname.endsWith("/")) {
    filePath = path.join(candidate, "index.html");
  } else if (await exists(candidate)) {
    const fileStat = await stat(candidate);
    if (fileStat.isDirectory()) {
      filePath = path.join(candidate, "index.html");
    }
  } else if (!path.extname(pathname)) {
    filePath = path.join(rootDir, "index.html");
  } else {
    return { statusCode: 404 };
  }

  if (!(await exists(filePath))) {
    return { statusCode: 404 };
  }

  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    return { statusCode: 404 };
  }

  return { filePath, fileStat, statusCode: 200 };
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, { Allow: "GET, HEAD" }, "Method Not Allowed");
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const resolved = await resolveFile(url.pathname);

    if (!resolved.filePath || !resolved.fileStat) {
      const message =
        resolved.statusCode === 403 ? "Forbidden" : resolved.statusCode === 404 ? "Not Found" : "Error";
      send(res, resolved.statusCode, { "Content-Type": "text/plain; charset=utf-8" }, message);
      return;
    }

    const extension = path.extname(resolved.filePath).toLowerCase();
    const headers = {
      "Cache-Control": url.pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "Content-Length": String(resolved.fileStat.size),
      "Content-Type": mimeTypes.get(extension) ?? "application/octet-stream",
    };

    res.writeHead(200, headers);

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    createReadStream(resolved.filePath).pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[static-server] ${message}`);
    send(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, "Internal Server Error");
  }
});

server.listen(port, host, () => {
  console.log(`[static-server] serving ${rootDir} on http://${host}:${port}`);
});
