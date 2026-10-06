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

// 5) Stateful scheduled Best-IP refresh.
//    - current entries are re-tested together with new candidates
//    - healthy current entries within hysteresis are retained first
//    - only materially better/failed entries are replaced
//    - pool defaults to 5 and remains configurable via env
const scheduledStart = "async function handleScheduled(_controller, env, _ctx) {";
const scheduledEnd = "\n\nexport default {";
const scheduled = `async function handleScheduled(_controller, env, _ctx) {
  const auto = String(env.BESTIP_AUTO || '').toLowerCase();
  // 家宽模式定时刷新：HOME_WAN_AUTO=1 时强制刷新 VPN Gate 家宽节点缓存（保证订阅拿到最新最快节点）
  const hwAuto = String(env.HOME_WAN_AUTO || '').toLowerCase();
  if (hwAuto === '1' || hwAuto === 'true') {
    try {
      const hcfg = await loadConfig(env);
      if (hcfg.homeWan) await resolveHomeWanNodes(env, hcfg, true);
    } catch (e) { /* 家宽刷新失败不影响其它 */ }
  }
  if (auto !== '1' && auto !== 'true') return;

  try {
    const cfg = await loadConfig(env);
    const cand = await collectCandidates(cfg.optimizer);
    const fresh = cand.candidates || [];
    const current = Array.isArray(cfg.preferredIPs) ? cfg.preferredIPs : [];

    // [CUSTOM] 小而稳定的优选池。BESTIP_POOL_SIZE 建议 3-5；允许 1-20。
    const poolSize = Math.max(1, Math.min(20,
      Number(env.BESTIP_POOL_SIZE || cfg.optimizer.count || 5) || 5));
    // [CUSTOM] 防抖阈值：当前 IP 只要仍健康，且延迟不比本轮最佳差超过该值，就优先保留。
    const hysteresisMs = Math.max(0, Math.min(500,
      Number(env.BESTIP_HYSTERESIS_MS || 25) || 25));

    // 把当前池也纳入复测，避免“新榜单稍快几毫秒”就整池替换。
    const merged = [];
    const seen = new Set();
    for (const x of [...current, ...fresh]) {
      if (!x || !x.ip) continue;
      const port = Number(x.port || cfg.optimizer.port || 443);
      const key = String(x.ip) + ':' + port;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ip: String(x.ip), port });
    }
    if (!merged.length) return;

    const results = await runLatencyTest(merged, cfg.optimizer.threads || 5, 5000);
    const healthy = results.filter(r => r.ok && r.latency >= 0);
    if (!healthy.length) return; // Fail-closed：本轮无法证明有更好节点，不覆盖现有池。

    const bestLatency = healthy[0].latency;
    const byKey = new Map(healthy.map(r => [String(r.ip) + ':' + Number(r.port || 443), r]));
    const selected = [];
    const selectedKeys = new Set();

    // 先保留健康且仍在合理性能窗口内的当前节点，保持账号/会话出口连续性。
    for (const x of current) {
      if (selected.length >= poolSize || !x || !x.ip) break;
      const port = Number(x.port || cfg.optimizer.port || 443);
      const key = String(x.ip) + ':' + port;
      const r = byKey.get(key);
      if (!r || r.latency > bestLatency + hysteresisMs) continue;
      selected.push({ ip: String(x.ip), port, latency: r.latency });
      selectedKeys.add(key);
    }

    // 再用本轮真正更优/替补节点补足。
    for (const r of healthy) {
      if (selected.length >= poolSize) break;
      const port = Number(r.port || 443);
      const key = String(r.ip) + ':' + port;
      if (selectedKeys.has(key)) continue;
      selected.push({ ip: String(r.ip), port, latency: r.latency });
      selectedKeys.add(key);
    }
    if (!selected.length) return;

    const newIPs = selected.map((r, i) => ({
      ip: r.ip,
      port: r.port,
      name: 'CF-BEST-' + String(i + 1).padStart(2, '0')
    }));

    const oldKeys = current.slice(0, poolSize).map(x => String(x.ip) + ':' + Number(x.port || 443));
    const newKeys = newIPs.map(x => String(x.ip) + ':' + Number(x.port || 443));
    if (oldKeys.length === newKeys.length && oldKeys.every((k, i) => k === newKeys[i])) return;

    cfg.preferredIPs = newIPs;
    await saveConfig(env, cfg);
  } catch (e) {
    // Fail-closed：自动优选异常时保留上一版 KV，不写空池、不做破坏性替换。
  }
}`;

replaceRange("stateful scheduled best-ip", scheduledStart, scheduledEnd, scheduled);


// 6) Expose local build identity in the UI and status APIs so the running
//    Worker can be distinguished from raw upstream even when VERSION is equal.
replaceOnce(
  "public version identity",
  "  if (segs[0] === 'version') {\n    return json({ version: VERSION });\n  }",
  "  if (segs[0] === 'version') {\n    return json({\n      version: VERSION,\n      patchset: CUSTOM_PATCHSET,\n      repo: CUSTOM_REPO,\n      upstream: CUSTOM_UPSTREAM\n    });\n  }"
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
