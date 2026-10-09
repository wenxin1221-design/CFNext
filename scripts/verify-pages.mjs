#!/usr/bin/env node
import fs from "node:fs";

const worker = "dist/_worker.js";
if (!fs.existsSync(worker)) throw new Error("[verify:pages] dist/_worker.js missing");

const code = fs.readFileSync(worker, "utf8");
const checks = [
  ["module worker", "export default"],
  ["cloudflare sockets", 'cloudflare:sockets'],
  ["custom patch", "const CUSTOM_PATCHSET = 'stable-bestip-v2';"],
  ["build identity api", "patchset: CUSTOM_PATCHSET"],
  ["pages refresh endpoint", "BESTIP_CRON_TOKEN"],
  ["pages refresh route", "bestip-refresh"]
];

for (const [name, marker] of checks) {
  if (!code.includes(marker)) throw new Error(`[verify:pages] missing ${name}: ${marker}`);
}

console.log("[verify:pages] Pages Advanced Mode worker OK");
