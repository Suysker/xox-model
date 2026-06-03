import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SandboxManifest } from '@xox/contracts'
import type { SandboxDataBundle } from '../backend.js'

export type SandboxInputEnvelope = ReturnType<typeof buildSandboxInputEnvelope>

export function buildSandboxInputEnvelope(manifest: SandboxManifest, bundle: SandboxDataBundle) {
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
  } as const
}

const PYTHON_HELPER = String.raw`
import json
import os
from pathlib import Path

def load():
    with open(os.environ["XOX_SANDBOX_INPUT_JSON"], "r", encoding="utf-8") as file:
        return json.load(file)

def emit(result):
    payload = load()
    manifest = payload["manifest"]
    bundle = payload["bundle"]
    output = dict(result or {})
    output["schemaVersion"] = "xox.sandbox.result.v1"
    output["observedInput"] = {
        "manifestId": manifest.get("manifestId"),
        "bundleId": bundle.get("bundleId"),
        "contentHash": bundle.get("contentHash"),
        "nonce": manifest.get("nonce"),
    }
    output_dir = Path(os.environ["XOX_SANDBOX_OUTPUT_DIR"])
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "result.json").write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
`.trimStart()

const JAVASCRIPT_HELPER = String.raw`
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function load() {
  return JSON.parse(readFileSync(process.env.XOX_SANDBOX_INPUT_JSON, "utf8"));
}

export function emit(result) {
  const payload = load();
  const output = {
    ...(result ?? {}),
    schemaVersion: "xox.sandbox.result.v1",
    observedInput: {
      manifestId: payload.manifest?.manifestId,
      bundleId: payload.bundle?.bundleId,
      contentHash: payload.bundle?.contentHash,
      nonce: payload.manifest?.nonce,
    },
  };
  mkdirSync(process.env.XOX_SANDBOX_OUTPUT_DIR, { recursive: true });
  writeFileSync(join(process.env.XOX_SANDBOX_OUTPUT_DIR, "result.json"), JSON.stringify(output, null, 2), "utf8");
}
`.trimStart()

export async function stageSandboxIo(input: {
  workDir: string
  inputJsonPath: string
  mountedInputJsonPath: string
  manifest: SandboxManifest
  bundle: SandboxDataBundle
}) {
  const envelope = buildSandboxInputEnvelope(input.manifest, input.bundle)
  const text = JSON.stringify(envelope, null, 2)
  await writeFile(input.inputJsonPath, text, 'utf8')
  await writeFile(input.mountedInputJsonPath, text, 'utf8')
  await writeFile(join(input.workDir, 'xox_sandbox.py'), PYTHON_HELPER, 'utf8')
  await writeFile(join(input.workDir, 'xox_sandbox.mjs'), JAVASCRIPT_HELPER, 'utf8')
}
