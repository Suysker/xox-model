import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SandboxManifest } from '@xox/contracts'
import type { SandboxDataBundle, SandboxToolDocument, SandboxToolSdkEntry } from '../backend.js'

export type SandboxInputEnvelope = ReturnType<typeof buildSandboxInputEnvelope>

export function buildSandboxInputEnvelope(
  manifest: SandboxManifest,
  bundle: SandboxDataBundle,
  toolSdk?: { tools: SandboxToolSdkEntry[]; documents: SandboxToolDocument[] },
) {
  return {
    schemaVersion: 'xox.sandbox.input.v1',
    manifest,
    bundle: {
      bundleId: bundle.bundleId,
      scope: bundle.scope,
      fields: bundle.fields,
      rows: bundle.rows ?? [],
      structured: bundle.structured,
      rowCount: bundle.rowCount ?? null,
      fileCount: bundle.fileCount ?? null,
      fileKinds: bundle.fileKinds ?? [],
      contentHash: bundle.contentHash,
    },
    toolSdk: {
      tools: toolSdk?.tools ?? [],
      documents: toolSdk?.documents ?? [],
    },
  } as const
}

const PYTHON_HELPER = String.raw`
import json
import os
import re
import time
import uuid
from pathlib import Path

_TOOL_CALLS = []

def load():
    with open(os.environ["XOX_SANDBOX_INPUT_JSON"], "r", encoding="utf-8") as file:
        payload = json.load(file)
    _mark_manifest_consumed("load")
    return payload

def load_bundle():
    return load()["bundle"]

def load_structured():
    return load_bundle()["structured"]

def load_rows():
    return load_bundle()["rows"]

def _tool_sdk():
    return load().get("toolSdk", {})

def _tools():
    return _tool_sdk().get("tools", [])

def _documents():
    return _tool_sdk().get("documents", [])

def _tool_by_name(name):
    for tool in _tools():
        if tool.get("name") == name:
            return tool
    return None

def _normalize_args(args, kwargs):
    if len(args) == 1 and isinstance(args[0], dict) and not kwargs:
        return dict(args[0])
    if len(args) == 0:
        return dict(kwargs)
    raise TypeError("xox_sandbox tool functions accept keyword arguments or one dict argument")

def _output_dir():
    output_dir = Path(os.environ["XOX_SANDBOX_OUTPUT_DIR"])
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir

def _mark_manifest_consumed(reason):
    try:
        payload = json.loads(Path(os.environ["XOX_SANDBOX_INPUT_JSON"]).read_text(encoding="utf-8"))
        manifest = payload.get("manifest", {})
        bundle = payload.get("bundle", {})
        proof = {
            "manifestId": manifest.get("manifestId"),
            "bundleId": bundle.get("bundleId"),
            "contentHash": bundle.get("contentHash"),
            "nonce": manifest.get("nonce"),
            "reason": reason,
        }
        (_output_dir() / "manifest_consumed.json").write_text(json.dumps(proof, ensure_ascii=False), encoding="utf-8")
    except Exception:
        return

def _write_tool_calls():
    path = _output_dir() / "tool_calls.jsonl"
    path.write_text(
        "\n".join(json.dumps(call, ensure_ascii=False) for call in _TOOL_CALLS),
        encoding="utf-8",
    )

def _record_tool_call(name, arguments, status="running", observation_id=None):
    tool = _tool_by_name(name) or {}
    call = {
        "callId": f"sandbox_sdk_{len(_TOOL_CALLS) + 1}_{name}_{uuid.uuid4().hex[:8]}",
        "toolName": name,
        "arguments": arguments,
        "riskLevel": tool.get("riskLevel"),
        "confirmationMode": tool.get("confirmationMode"),
        "navigationTarget": tool.get("navigationTarget"),
        "source": "sandbox_sdk",
        "status": status,
    }
    if observation_id:
        call["observationId"] = observation_id
    _TOOL_CALLS.append(call)
    _write_tool_calls()
    return call

def _update_tool_call(call, **updates):
    call.update({key: value for key, value in updates.items() if value is not None})
    _write_tool_calls()

def _rpc_dirs():
    root = os.environ.get("XOX_SANDBOX_TOOL_RPC_DIR")
    if not root:
        return None, None
    root_path = Path(root)
    requests = root_path / "requests"
    responses = root_path / "responses"
    requests.mkdir(parents=True, exist_ok=True)
    responses.mkdir(parents=True, exist_ok=True)
    return requests, responses

def _rpc_tool_call(name, arguments):
    _mark_manifest_consumed(f"tool:{name}")
    call = _record_tool_call(name, arguments)
    requests, responses = _rpc_dirs()
    if not requests or not responses:
        _update_tool_call(call, status="failed", error={"code": "sandbox.tool_runtime_unavailable"})
        return {
            "ok": False,
            "toolName": name,
            "error": {
                "code": "sandbox.tool_runtime_unavailable",
                "message": "No Tool Runtime Gateway handler is attached to this sandbox session.",
                "repairable": True,
            },
        }
    request = {"id": call["callId"], "toolName": name, "arguments": arguments}
    request_path = requests / f"{call['callId']}.json"
    response_path = responses / f"{call['callId']}.json"
    request_path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    deadline = time.time() + float(os.environ.get("XOX_SANDBOX_TOOL_RPC_TIMEOUT_SECONDS", "8"))
    while time.time() < deadline:
        if response_path.exists():
            response = json.loads(response_path.read_text(encoding="utf-8"))
            status = response.get("status") or ("completed" if response.get("ok") else "failed")
            _update_tool_call(
                call,
                status=status,
                observationId=response.get("observationId"),
                error=response.get("error"),
            )
            return response.get("output") if response.get("ok") else response
        time.sleep(0.025)
    _update_tool_call(call, status="failed", error={"code": "sandbox.tool_runtime_timeout"})
    return {
        "ok": False,
        "toolName": name,
        "error": {
            "code": "sandbox.tool_runtime_timeout",
            "message": f"Timed out waiting for Tool Runtime Gateway response for {name}.",
            "repairable": True,
        },
    }

def _read_tool_result(name, arguments):
    if name == "rg":
        return rg(**arguments)
    if name == "tool_discover":
        query = str(arguments.get("query") or "").lower()
        max_results = int(arguments.get("maxResults") or arguments.get("limit") or 8)
        matches = []
        for tool in _tools():
            haystack = " ".join(str(tool.get(key) or "") for key in ["name", "summary", "capability"])
            if not query or query in haystack.lower():
                matches.append(tool)
        return {
            "observationType": "tool_discovery",
            "query": query,
            "matchedToolNames": [tool.get("name") for tool in matches[:max_results]],
            "descriptors": matches[:max_results],
        }
    return {
        "ok": False,
        "toolName": name,
        "error": {
            "code": "sandbox.tool_not_available",
            "message": f"{name} is not available as a read tool inside this sandbox session.",
            "repairable": True,
        },
    }

def call_tool(name, *args, **kwargs):
    arguments = _normalize_args(args, kwargs)
    tool = _tool_by_name(name)
    if not tool:
        return {
            "ok": False,
            "toolName": name,
            "error": {
                "code": "sandbox.tool_not_in_manifest",
                "message": f"{name} is not present in the scoped sandbox tool manifest.",
                "repairable": True,
            },
        }
    _mark_manifest_consumed(f"tool:{name}")
    if tool.get("riskLevel") == "read" and tool.get("confirmationMode") == "never":
        if name in ("rg", "tool_discover"):
            return _read_tool_result(name, arguments)
        return _rpc_tool_call(name, arguments)
    call = _record_tool_call(name, arguments, status="pending_approval")
    return {
        "ok": False,
        "requiresApproval": True,
        "toolName": name,
        "arguments": arguments,
        "observationId": call.get("callId"),
        "message": "This sandbox tool call is recorded for the Tool Runtime Gateway.",
    }

def rg(pattern, paths=None, context_lines=0, max_matches=20, regex=False, **_unused):
    needle = str(pattern or "")
    if not needle:
        return {"matches": [], "truncated": False}
    requested_paths = set(paths or [])
    max_matches = max(1, min(int(max_matches or 20), 50))
    context_lines = max(0, min(int(context_lines or 0), 5))
    flags = 0
    compiled = re.compile(needle, flags) if regex else None
    matches = []
    for document in _documents():
        path = str(document.get("path") or "")
        if requested_paths and path not in requested_paths:
            continue
        if path.startswith("/") or ".." in path.split("/"):
            continue
        lines = str(document.get("text") or "").splitlines()
        for index, line in enumerate(lines):
            found = bool(compiled.search(line)) if compiled else needle.lower() in line.lower()
            if not found:
                continue
            before = lines[max(0, index - context_lines):index]
            after = lines[index + 1:index + 1 + context_lines]
            matches.append({
                "path": path,
                "line": index + 1,
                "text": line,
                "before": before,
                "after": after,
            })
            if len(matches) >= max_matches:
                return {"matches": matches, "truncated": True}
    return {"matches": matches, "truncated": False}

def emit(result):
    output = dict(result or {})
    output["schemaVersion"] = "xox.sandbox.result.v1"
    if _TOOL_CALLS and "sandboxToolCalls" not in output:
        output["sandboxToolCalls"] = list(_TOOL_CALLS)
    output_dir = _output_dir()
    (output_dir / "result.json").write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")

def _install_tool_functions():
    for tool in _tools():
        name = tool.get("name")
        if not isinstance(name, str) or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
            continue
        if name in globals():
            continue
        def _make_tool(tool_name):
            def _tool(*args, **kwargs):
                return call_tool(tool_name, *args, **kwargs)
            _tool.__name__ = tool_name
            return _tool
        globals()[name] = _make_tool(name)

_install_tool_functions()
`.trimStart()

function camelCaseToolName(name: string) {
  return name.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase())
}

function javascriptHelper(tools: SandboxToolSdkEntry[] = []) {
  const generatedExports = tools
    .filter((tool) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(tool.name))
    .flatMap((tool) => {
      const camel = camelCaseToolName(tool.name)
      const exports = [`export function ${tool.name}(args = {}) { return callTool(${JSON.stringify(tool.name)}, args); }`]
      if (camel !== tool.name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(camel)) {
        exports.push(`export function ${camel}(args = {}) { return callTool(${JSON.stringify(tool.name)}, args); }`)
      }
      return exports
    })
    .join('\n')
  return String.raw`
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const toolCalls = [];

export function load() {
  const payload = JSON.parse(readFileSync(process.env.XOX_SANDBOX_INPUT_JSON, "utf8"));
  markManifestConsumed("load");
  return payload;
}

export function loadBundle() {
  return load().bundle;
}

export function loadStructured() {
  return loadBundle().structured;
}

export function loadRows() {
  return loadBundle().rows;
}

function toolSdk() {
  return load().toolSdk ?? {};
}

function tools() {
  return toolSdk().tools ?? [];
}

function documents() {
  return toolSdk().documents ?? [];
}

function toolByName(name) {
  return tools().find((tool) => tool.name === name) ?? null;
}

function outputDir() {
  mkdirSync(process.env.XOX_SANDBOX_OUTPUT_DIR, { recursive: true });
  return process.env.XOX_SANDBOX_OUTPUT_DIR;
}

function markManifestConsumed(reason) {
  try {
    const payload = JSON.parse(readFileSync(process.env.XOX_SANDBOX_INPUT_JSON, "utf8"));
    const manifest = payload.manifest ?? {};
    const bundle = payload.bundle ?? {};
    writeFileSync(join(outputDir(), "manifest_consumed.json"), JSON.stringify({
      manifestId: manifest.manifestId,
      bundleId: bundle.bundleId,
      contentHash: bundle.contentHash,
      nonce: manifest.nonce,
      reason,
    }), "utf8");
  } catch {
    // Consumption proof is best-effort; the parent treats missing proof as invalid evidence.
  }
}

function writeToolCalls() {
  writeFileSync(
    join(outputDir(), "tool_calls.jsonl"),
    toolCalls.map((call) => JSON.stringify(call)).join("\n"),
    "utf8",
  );
}

function recordToolCall(name, args, status = "running", observationId = null) {
  const tool = toolByName(name) ?? {};
  const call = {
    callId: "sandbox_sdk_" + (toolCalls.length + 1) + "_" + name + "_" + randomUUID().slice(0, 8),
    toolName: name,
    arguments: args ?? {},
    riskLevel: tool.riskLevel,
    confirmationMode: tool.confirmationMode,
    navigationTarget: tool.navigationTarget,
    source: "sandbox_sdk",
    status,
  };
  if (observationId) call.observationId = observationId;
  toolCalls.push(call);
  writeToolCalls();
  return call;
}

function updateToolCall(call, updates = {}) {
  Object.assign(call, Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined && value !== null)));
  writeToolCalls();
}

function rpcDirs() {
  const root = process.env.XOX_SANDBOX_TOOL_RPC_DIR;
  if (!root) return null;
  const requests = join(root, "requests");
  const responses = join(root, "responses");
  mkdirSync(requests, { recursive: true });
  mkdirSync(responses, { recursive: true });
  return { requests, responses };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rpcToolCall(name, args = {}) {
  markManifestConsumed("tool:" + name);
  const call = recordToolCall(name, args);
  const dirs = rpcDirs();
  if (!dirs) {
    updateToolCall(call, { status: "failed", error: { code: "sandbox.tool_runtime_unavailable" } });
    return {
      ok: false,
      toolName: name,
      error: {
        code: "sandbox.tool_runtime_unavailable",
        message: "No Tool Runtime Gateway handler is attached to this sandbox session.",
        repairable: true,
      },
    };
  }
  const request = { id: call.callId, toolName: name, arguments: args ?? {} };
  const requestPath = join(dirs.requests, call.callId + ".json");
  const responsePath = join(dirs.responses, call.callId + ".json");
  writeFileSync(requestPath, JSON.stringify(request), "utf8");
  const deadline = Date.now() + Number(process.env.XOX_SANDBOX_TOOL_RPC_TIMEOUT_SECONDS ?? 8) * 1000;
  while (Date.now() < deadline) {
    if (existsSync(responsePath)) {
      const response = JSON.parse(readFileSync(responsePath, "utf8"));
      const status = response.status ?? (response.ok ? "completed" : "failed");
      updateToolCall(call, {
        status,
        observationId: response.observationId,
        error: response.error,
      });
      return response.ok ? response.output : response;
    }
    sleep(25);
  }
  updateToolCall(call, { status: "failed", error: { code: "sandbox.tool_runtime_timeout" } });
  return {
    ok: false,
    toolName: name,
    error: {
      code: "sandbox.tool_runtime_timeout",
      message: "Timed out waiting for Tool Runtime Gateway response for " + name + ".",
      repairable: true,
    },
  };
}

export function rg(args = {}) {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return { matches: [], truncated: false };
  const requestedPaths = new Set(args.paths ?? []);
  const maxMatches = Math.max(1, Math.min(Number(args.maxMatches ?? args.max_matches ?? 20), 50));
  const contextLines = Math.max(0, Math.min(Number(args.contextLines ?? args.context_lines ?? 0), 5));
  const matcher = args.regex ? new RegExp(pattern) : null;
  const matches = [];
  for (const document of documents()) {
    const path = String(document.path ?? "");
    if (requestedPaths.size > 0 && !requestedPaths.has(path)) continue;
    if (path.startsWith("/") || path.split("/").includes("..")) continue;
    const lines = String(document.text ?? "").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const found = matcher ? matcher.test(line) : line.toLowerCase().includes(pattern.toLowerCase());
      if (!found) continue;
      matches.push({
        path,
        line: index + 1,
        text: line,
        before: lines.slice(Math.max(0, index - contextLines), index),
        after: lines.slice(index + 1, index + 1 + contextLines),
      });
      if (matches.length >= maxMatches) return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

function readToolResult(name, args = {}) {
  if (name === "rg") return rg(args);
  if (name === "tool_discover") {
    const query = String(args.query ?? "").toLowerCase();
    const maxResults = Math.max(1, Math.min(Number(args.maxResults ?? args.limit ?? 8), 12));
    const matches = tools().filter((tool) => {
      const haystack = [tool.name, tool.summary, tool.capability].filter(Boolean).join(" ").toLowerCase();
      return !query || haystack.includes(query);
    }).slice(0, maxResults);
    return {
      observationType: "tool_discovery",
      query,
      matchedToolNames: matches.map((tool) => tool.name),
      descriptors: matches,
    };
  }
  return {
    ok: false,
    toolName: name,
    error: {
      code: "sandbox.tool_not_available",
      message: name + " is not available as a read tool inside this sandbox session.",
      repairable: true,
    },
  };
}

export function callTool(name, args = {}) {
  const tool = toolByName(name);
  if (!tool) {
    return {
      ok: false,
      toolName: name,
      error: {
        code: "sandbox.tool_not_in_manifest",
        message: name + " is not present in the scoped sandbox tool manifest.",
        repairable: true,
      },
    };
  }
  markManifestConsumed("tool:" + name);
  if (tool.riskLevel === "read" && tool.confirmationMode === "never") {
    if (name === "rg" || name === "tool_discover") return readToolResult(name, args);
    return rpcToolCall(name, args);
  }
  const call = recordToolCall(name, args, "pending_approval");
  return {
    ok: false,
    requiresApproval: true,
    toolName: name,
    arguments: args ?? {},
    observationId: call.callId,
    message: "This sandbox tool call is recorded for the Tool Runtime Gateway.",
  };
}

export function emit(result) {
  const output = {
    ...(result ?? {}),
    schemaVersion: "xox.sandbox.result.v1",
    ...(toolCalls.length > 0 && !Object.hasOwn(result ?? {}, "sandboxToolCalls") ? { sandboxToolCalls: toolCalls } : {}),
  };
  writeFileSync(join(outputDir(), "result.json"), JSON.stringify(output, null, 2), "utf8");
}

${generatedExports}
`.trimStart()
}

export async function stageSandboxIo(input: {
  workDir: string
  inputJsonPath: string
  mountedInputJsonPath: string
  manifest: SandboxManifest
  bundle: SandboxDataBundle
  toolSdk?: {
    tools: SandboxToolSdkEntry[]
    documents: SandboxToolDocument[]
  }
}) {
  const envelope = buildSandboxInputEnvelope(input.manifest, input.bundle, input.toolSdk)
  const text = JSON.stringify(envelope, null, 2)
  await writeFile(input.inputJsonPath, text, 'utf8')
  await writeFile(input.mountedInputJsonPath, text, 'utf8')
  await writeFile(join(input.workDir, 'xox_sandbox.py'), PYTHON_HELPER, 'utf8')
  await writeFile(join(input.workDir, 'xox_sandbox.mjs'), javascriptHelper(input.toolSdk?.tools), 'utf8')
}
