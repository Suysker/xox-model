#!/usr/bin/env node

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const rootDir = path.resolve(process.env.STATIC_ROOT ?? path.join(process.cwd(), "dist"));
const apiUpstream = normalizeUpstream(process.env.API_UPSTREAM ?? "http://127.0.0.1:8000");
const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

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

function normalizeUpstream(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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

async function readRequestBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function buildProxyHeaders(req) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    const normalizedKey = key.toLowerCase();
    if (hopByHopHeaders.has(normalizedKey) || value == null) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(normalizedKey, entry);
      }
      continue;
    }

    headers.set(normalizedKey, value);
  }

  const forwardedFor = req.socket.remoteAddress;
  if (forwardedFor) {
    const existing = headers.get("x-forwarded-for");
    headers.set("x-forwarded-for", existing ? `${existing}, ${forwardedFor}` : forwardedFor);
  }

  headers.set("x-forwarded-host", req.headers.host ?? `127.0.0.1:${port}`);
  headers.set("x-forwarded-proto", "http");
  return headers;
}

function applyProxyResponseHeaders(res, upstreamResponse) {
  const responseHeaders = {};

  for (const [key, value] of upstreamResponse.headers.entries()) {
    const normalizedKey = key.toLowerCase();
    if (hopByHopHeaders.has(normalizedKey) || normalizedKey === "set-cookie") {
      continue;
    }

    responseHeaders[key] = value;
  }

  const getSetCookie = upstreamResponse.headers.getSetCookie?.bind(upstreamResponse.headers);
  const setCookies = typeof getSetCookie === "function" ? getSetCookie() : [];
  if (setCookies.length > 0) {
    responseHeaders["Set-Cookie"] = setCookies;
  }

  return responseHeaders;
}

async function proxyRequest(req, res, url) {
  try {
    const upstreamUrl = `${apiUpstream}${url.pathname}${url.search}`;
    const init = {
      method: req.method,
      headers: buildProxyHeaders(req),
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = await readRequestBody(req);
    }

    const upstreamResponse = await fetch(upstreamUrl, init);
    const responseHeaders = applyProxyResponseHeaders(res, upstreamResponse);
    const body =
      req.method === "HEAD" || upstreamResponse.status === 204
        ? null
        : Buffer.from(await upstreamResponse.arrayBuffer());

    if (body && !("content-length" in responseHeaders) && !("Content-Length" in responseHeaders)) {
      responseHeaders["Content-Length"] = String(body.length);
    }

    res.writeHead(upstreamResponse.status, responseHeaders);

    if (body == null) {
      res.end();
      return;
    }

    res.end(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[static-server] proxy error: ${message}`);
    send(res, 502, { "Content-Type": "text/plain; charset=utf-8" }, "Bad Gateway");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await proxyRequest(req, res, url);
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[static-server] ${message}`);
    send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad Request");
    return;
  }

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
