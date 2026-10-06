#!/usr/bin/env node
import fs from "node:fs";

const file = process.argv[2] || "CFNext 明文版.js";
const code = fs.readFileSync(file, "utf8");

const checks = [
  ["custom patchset", "const CUSTOM_PATCHSET = 'stable-bestip-v1';"],
  ["custom update repo", "const UPDATE_REPO = 'wenxin1221-design/CFNext';"],
  ["stable default", "  loadBalance: false,"],
  ["small pool", "    count: 5,"],
  ["hysteresis", "BESTIP_HYSTERESIS_MS"],
  ["pool size", "BESTIP_POOL_SIZE"],
  ["fail closed comment", "Fail-closed：自动优选异常时保留上一版 KV"]
];

for (const [name, needle] of checks) {
  if (!code.includes(needle)) throw new Error(`[verify] missing ${name}: ${needle}`);
}
if (!code.includes("export default")) throw new Error("[verify] missing export default");
if (!code.includes("from 'cloudflare:sockets'")) throw new Error("[verify] missing cloudflare:sockets import");

console.log("[verify] custom invariants OK");
