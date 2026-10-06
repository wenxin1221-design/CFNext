#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const source = path.resolve("CFNext 明文版.js");
const outDir = path.resolve("dist");
const target = path.join(outDir, "_worker.js");

if (!fs.existsSync(source)) {
  throw new Error("[build:pages] missing CFNext 明文版.js");
}

const code = fs.readFileSync(source, "utf8");
const required = [
  "from 'cloudflare:sockets'",
  "export default",
  "const CUSTOM_PATCHSET = 'stable-bestip-v1';",
  "patchset: CUSTOM_PATCHSET",
  "BESTIP_CRON_TOKEN",
  "/_ops/bestip-refresh"
];

for (const marker of required) {
  if (!code.includes(marker)) {
    throw new Error(`[build:pages] missing required marker: ${marker}`);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(target, code);

const meta = {
  generatedAt: new Date().toISOString(),
  source: "CFNext 明文版.js",
  patchset: "stable-bestip-v1",
  deployment: "cloudflare-pages-advanced-mode"
};
fs.writeFileSync(path.join(outDir, "build-meta.json"), JSON.stringify(meta, null, 2) + "\n");

console.log(`[build:pages] wrote ${target} (${Buffer.byteLength(code)} bytes)`);
