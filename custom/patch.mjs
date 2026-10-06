#!/usr/bin/env node
/**
 * CFNext local customization patch.
 *
 * Source of truth:
 *   upstream: PAICNI/CFNext -> CFNext 明文版.js
 *   local patch: this file
 *
 * This script MUST fail closed. If upstream changes an expected anchor, throw
 * instead of silently producing an uncustomized build.
 */
import fs from "node:fs";

const input = process.argv[2] || "CFNext 明文版.js";
const output = process.argv[3] || input;
let code = fs.readFileSync(input, "utf8");

function replaceOnce(label, search, replacement) {
  const first = code.indexOf(search);
  if (first < 0) throw new Error(`[patch] missing anchor: ${label}`);
  const second = code.indexOf(search, first + search.length);
  if (second >= 0) throw new Error(`[patch] anchor is not unique: ${label}`);
  code = code.slice(0, first) + replacement + code.slice(first + search.length);
}

function replaceRange(label, startMarker, endMarker, replacement) {
  const start = code.indexOf(startMarker);
  if (start < 0) throw new Error(`[patch] missing start marker: ${label}`);
  const end = code.indexOf(endMarker, start);
  if (end < 0) throw new Error(`[patch] missing end marker: ${label}`);
  if (code.indexOf(startMarker, start + startMarker.length) >= 0) {
    throw new Error(`[patch] start marker is not unique: ${label}`);
  }
  code = code.slice(0, start) + replacement + code.slice(end);
}

// 1) Build identity. Keep upstream VERSION untouched so compatibility/version
//    comparisons remain meaningful; CUSTOM_PATCHSET identifies our delta.
{
  const re = /const VERSION = ['"]([^'"]+)['"];/;
  const matches = [...code.matchAll(new RegExp(re.source, 'g'))];
  if (matches.length !== 1) throw new Error('[patch] expected exactly one VERSION declaration');
  const original = matches[0][0];
  code = code.replace(re, original +
    "\nconst CUSTOM_UPSTREAM = 'PAICNI/CFNext';" +
    "\nconst CUSTOM_REPO = 'wenxin1221-design/CFNext';" +
    "\nconst CUSTOM_PATCHSET = 'stable-bestip-v1';");
}

// 2) The in-panel update checker must point to our customized repository.
//    Otherwise clicking update would return raw upstream code and remove local
//    behavior.
replaceOnce(
  "update repository",
  "const UPDATE_REPO = 'PAICNI/CFNext';",
  "const UPDATE_REPO = 'wenxin1221-design/CFNext';"
);

// 3) Stable-by-default delivery. OpenClash/Mihomo is responsible for runtime
//    health-check/failover, so CFNext should not reshuffle order on each fetch.
replaceOnce(
  "load balance default",
  "  loadBalance: true,    // 负载均衡：每次订阅请求对下发节点顺序做随机轮换（Fisher-Yates 打乱），分散客户端连接、避免头部节点拥塞变慢；关闭则保持原有固定顺序",
  "  loadBalance: false,   // [CUSTOM] 稳定优先：默认关闭每次订阅随机洗牌，由 OpenClash/Mihomo 在客户端侧负责 health-check/failover；需要上游原行为时可在面板手动开启"
);

// 4) Keep the automatic preferred-IP pool small and inspectable by default.
replaceOnce(
  "optimizer default count",
  "    count: 20,",
  "    count: 5,          // [CUSTOM] 默认维护 5 个优选入口，避免大池污染客户端探测与频繁漂移"
);

// 5) Stateful Best-IP refresh with a reusable refreshBestIPs() function.
//    The scheduled() handler remains for compatibility, while Pages production
//    calls the same logic through a protected HTTP operations endpoint.
replaceOnce(
  "pages bestip env docs",
  "//    BESTIP_AUTO     1 启用定时自动优选（scheduled 刷新）",
  "//    BESTIP_AUTO     1 启用自动优选；Pages 生产环境由受保护 HTTP 调度入口触发\\n//    BESTIP_CRON_TOKEN 保护 /_ops/bestip-refresh 的 Bearer Token（Pages 定时调度用）"
);

const scheduledStart = "async function handleScheduled(_controller, env, _ctx) {";
const scheduledEnd = "\n\nexport default {";
const scheduled = "async function refreshBestIPs(env) {\n  const auto = String(env.BESTIP_AUTO || '').toLowerCase();\n  if (auto !== '1' && auto !== 'true') return { status: 'disabled' };\n\n  const cfg = await loadConfig(env);\n  const cand = await collectCandidates(cfg.optimizer);\n  const fresh = cand.candidates || [];\n  const current = Array.isArray(cfg.preferredIPs) ? cfg.preferredIPs : [];\n\n  // [CUSTOM] 小而稳定的优选池。BESTIP_POOL_SIZE 建议 3-5；允许 1-20。\n  const poolSize = Math.max(1, Math.min(20,\n    Number(env.BESTIP_POOL_SIZE || cfg.optimizer.count || 5) || 5));\n  // [CUSTOM] 防抖阈值：当前 IP 只要仍健康，且延迟不比本轮最佳差超过该值，就优先保留。\n  const hysteresisMs = Math.max(0, Math.min(500,\n    Number(env.BESTIP_HYSTERESIS_MS || 25) || 25));\n\n  // 把当前池也纳入复测，避免“新榜单稍快几毫秒”就整池替换。\n  const merged = [];\n  const seen = new Set();\n  for (const x of [...current, ...fresh]) {\n    if (!x || !x.ip) continue;\n    const port = Number(x.port || cfg.optimizer.port || 443);\n    const key = String(x.ip) + ':' + port;\n    if (seen.has(key)) continue;\n    seen.add(key);\n    merged.push({ ip: String(x.ip), port });\n  }\n  if (!merged.length) return { status: 'no-candidates', poolSize };\n\n  const results = await runLatencyTest(merged, cfg.optimizer.threads || 5, 5000);\n  const healthy = results.filter(r => r.ok && r.latency >= 0);\n  if (!healthy.length) return { status: 'no-healthy-candidates', poolSize }; // Fail-Closed\n\n  const bestLatency = healthy[0].latency;\n  const byKey = new Map(healthy.map(r => [String(r.ip) + ':' + Number(r.port || 443), r]));\n  const selected = [];\n  const selectedKeys = new Set();\n\n  // 先保留健康且仍在合理性能窗口内的当前节点，保持账号/会话出口连续性。\n  for (const x of current) {\n    if (selected.length >= poolSize || !x || !x.ip) break;\n    const port = Number(x.port || cfg.optimizer.port || 443);\n    const key = String(x.ip) + ':' + port;\n    const r = byKey.get(key);\n    if (!r || r.latency > bestLatency + hysteresisMs) continue;\n    selected.push({ ip: String(x.ip), port, latency: r.latency });\n    selectedKeys.add(key);\n  }\n\n  // 再用本轮真正更优/替补节点补足。\n  for (const r of healthy) {\n    if (selected.length >= poolSize) break;\n    const port = Number(r.port || 443);\n    const key = String(r.ip) + ':' + port;\n    if (selectedKeys.has(key)) continue;\n    selected.push({ ip: String(r.ip), port, latency: r.latency });\n    selectedKeys.add(key);\n  }\n  if (!selected.length) return { status: 'no-selection', poolSize };\n\n  const newIPs = selected.map((r, i) => ({\n    ip: r.ip,\n    port: r.port,\n    name: 'CF-BEST-' + String(i + 1).padStart(2, '0')\n  }));\n\n  const oldKeys = current.slice(0, poolSize).map(x => String(x.ip) + ':' + Number(x.port || 443));\n  const newKeys = newIPs.map(x => String(x.ip) + ':' + Number(x.port || 443));\n  if (oldKeys.length === newKeys.length && oldKeys.every((k, i) => k === newKeys[i])) {\n    return { status: 'unchanged', poolSize, bestLatency, selected: newIPs.length };\n  }\n\n  cfg.preferredIPs = newIPs;\n  await saveConfig(env, cfg);\n  return { status: 'updated', poolSize, bestLatency, selected: newIPs.length };\n}\n\nasync function handleScheduled(_controller, env, _ctx) {\n  // 兼容独立 Worker/本地测试；Pages 生产环境不依赖 Cron Trigger，而由受保护 HTTP 调度入口调用 refreshBestIPs。\n  const hwAuto = String(env.HOME_WAN_AUTO || '').toLowerCase();\n  if (hwAuto === '1' || hwAuto === 'true') {\n    try {\n      const hcfg = await loadConfig(env);\n      if (hcfg.homeWan) await resolveHomeWanNodes(env, hcfg, true);\n    } catch (e) { /* 家宽刷新失败不影响其它 */ }\n  }\n  try {\n    await refreshBestIPs(env);\n  } catch (e) {\n    // Fail-Closed：自动优选异常时保留上一版 KV，不写空池、不做破坏性替换。\n  }\n}";

replaceRange("stateful pages-compatible best-ip", scheduledStart, scheduledEnd, scheduled);

// 6) Expose local build identity in the UI and status APIs so the running
//    Worker can be distinguished from raw upstream even when VERSION is equal.
replaceOnce(
  "public version identity",
  "  if (segs[0] === 'version') {\n    return json({ version: VERSION });\n  }",
  "  if (segs[0] === 'version') {\n    return json({\n      version: VERSION,\n      patchset: CUSTOM_PATCHSET,\n      repo: CUSTOM_REPO,\n      upstream: CUSTOM_UPSTREAM\n    });\n  }"
);

replaceOnce(
  "pages operations endpoint",
  "  // ---------- 登录 / 首次设置 ----------",
  "  // ---------- Pages 运维调度入口 ----------\n  // Pages 没有使用本仓库旧 Worker Cron Trigger；由外部调度器以 Bearer Token 调用。\n  if (segs[0] === '_ops' && segs[1] === 'bestip-refresh') {\n    if (request.method !== 'POST') return new Response('Not Found', { status: 404 });\n    const expected = String(env.BESTIP_CRON_TOKEN || '');\n    const auth = request.headers.get('Authorization') || '';\n    if (!expected || auth !== 'Bearer ' + expected) return new Response('Not Found', { status: 404 });\n    try {\n      const result = await refreshBestIPs(env);\n      return json({ ok: true, data: result });\n    } catch (e) {\n      return json({ ok: false, msg: 'Best-IP 刷新失败: ' + (e.message || e) }, 500);\n    }\n  }\n\n  // ---------- 登录 / 首次设置 ----------"
);

replaceOnce(
  "dashboard runtime identity",
  "        <div class=\"kv\"><span class=\"k\">协议</span><span class=\"v\" id=\"stProto\">—</span></div>\n        <div class=\"kv\"><span class=\"k\">KV 持久化</span><span class=\"v\" id=\"stKv\">—</span></div>\n        <div class=\"kv\"><span class=\"k\">面板入口</span><span class=\"v\" id=\"stEntry\">—</span></div>",
  "        <div class=\"kv\"><span class=\"k\">协议</span><span class=\"v\" id=\"stProto\">—</span></div>\n        <div class=\"kv\"><span class=\"k\">本地定制</span><span class=\"v ok\" id=\"stPatch\">—</span></div>\n        <div class=\"kv\"><span class=\"k\">代码来源</span><span class=\"v\" id=\"stRepo\">—</span></div>\n        <div class=\"kv\"><span class=\"k\">KV 持久化</span><span class=\"v\" id=\"stKv\">—</span></div>\n        <div class=\"kv\"><span class=\"k\">面板入口</span><span class=\"v\" id=\"stEntry\">—</span></div>"
);

replaceOnce(
  "settings runtime identity",
  "        <div class=\"kv\"><span class=\"k\">面板版本</span><span class=\"v\" id=\"aVer\">—</span></div>\n        <div class=\"kv\"><span class=\"k\">KV 持久化</span><span class=\"v\" id=\"aKv\">—</span></div>",
  "        <div class=\"kv\"><span class=\"k\">面板版本</span><span class=\"v\" id=\"aVer\">—</span></div>\n        <div class=\"kv\"><span class=\"k\">本地补丁</span><span class=\"v ok\" id=\"aPatch\">—</span></div>\n        <div class=\"kv\"><span class=\"k\">代码来源</span><span class=\"v\" id=\"aRepo\">—</span></div>\n        <div class=\"kv\"><span class=\"k\">上游来源</span><span class=\"v\" id=\"aUpstream\">—</span></div>\n        <div class=\"kv\"><span class=\"k\">KV 持久化</span><span class=\"v\" id=\"aKv\">—</span></div>"
);

replaceOnce(
  "render custom identity",
  "  var v = d.version || '—';\n  var kindName = (d.kind === '混淆版') ? '混淆版' : '明文版';   // 部署形态（明文版 / 混淆版），由后端自检\n  $('sideVer').textContent = 'v' + v + ' ' + kindName;\n  topVerText = 'v' + v + ' ' + kindName;\n  $('aVer').textContent = v + ' ' + kindName;",
  "  var v = d.version || '—';\n  var kindName = (d.kind === '混淆版') ? '混淆版' : '明文版';   // 部署形态（明文版 / 混淆版），由后端自检\n  var patchset = d.patchset || '';\n  var shortPatch = patchset ? patchset.replace(/^stable-bestip-/, '') : '';\n  var customSuffix = shortPatch ? ' · Custom ' + shortPatch : '';\n  $('sideVer').textContent = 'v' + v + ' ' + kindName + customSuffix;\n  topVerText = 'v' + v + ' ' + kindName + customSuffix;\n  $('aVer').textContent = v + ' ' + kindName;\n  $('stPatch').textContent = patchset || '未检测到';\n  $('stPatch').className = 'v ' + (patchset ? 'ok' : 'bad');\n  $('stRepo').textContent = d.repo || '—';\n  $('aPatch').textContent = patchset || '未检测到';\n  $('aPatch').className = 'v ' + (patchset ? 'ok' : 'bad');\n  $('aRepo').textContent = d.repo || '—';\n  $('aUpstream').textContent = d.upstream || '—';"
);

replaceOnce(
  "status api identity",
  "    if (apiName === 'status') {\n      return json({ ok: true, data: { version: VERSION, kind: deployKind() === 'obfuscated' ? '混淆版' : '明文版', host: url.hostname, path: panelPath, region: (request.cf && request.cf.colo) || 'unknown', kv: !!(env.K && typeof env.K.get === 'function'), workersDev: /\\.workers\\.dev$/i.test(url.hostname) } });\n    }",
  "    if (apiName === 'status') {\n      return json({ ok: true, data: {\n        version: VERSION,\n        patchset: CUSTOM_PATCHSET,\n        repo: CUSTOM_REPO,\n        upstream: CUSTOM_UPSTREAM,\n        kind: deployKind() === 'obfuscated' ? '混淆版' : '明文版',\n        host: url.hostname,\n        path: panelPath,\n        region: (request.cf && request.cf.colo) || 'unknown',\n        kv: !!(env.K && typeof env.K.get === 'function'),\n        workersDev: /\\.workers\\.dev$/i.test(url.hostname)\n      } });\n    }"
);

replaceOnce(
  "update api identity",
  "        const d = { current: r.current, latest: r.latest, hasUpdate: r.hasUpdate, kind: r.kind, error: r.error || '' };",
  "        const d = { current: r.current, latest: r.latest, hasUpdate: r.hasUpdate, kind: r.kind, patchset: CUSTOM_PATCHSET, repo: CUSTOM_REPO, upstream: CUSTOM_UPSTREAM, error: r.error || '' };"
);

replaceOnce(
  "update ui identity",
  "    topVerText = 'v' + d.current + ' ' + kindName;\n    sv.textContent = topVerText;",
  "    var shortPatch = d.patchset ? String(d.patchset).replace(/^stable-bestip-/, '') : '';\n    var customSuffix = shortPatch ? ' · Custom ' + shortPatch : '';\n    topVerText = 'v' + d.current + ' ' + kindName + customSuffix;\n    sv.textContent = topVerText;"
);

fs.writeFileSync(output, code);
console.log(`[patch] wrote ${output}`);
