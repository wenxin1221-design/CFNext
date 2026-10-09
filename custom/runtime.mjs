// Injected after structural adapter validation; no Cloudflare runtime dependencies.
const CUSTOM_UPSTREAM = 'PAICNI/CFNext';
const CUSTOM_REPO = 'wenxin1221-design/CFNext';
const CUSTOM_PATCHSET = 'stable-bestip-v2';
function customIdentity() { return {version: VERSION, patchset: CUSTOM_PATCHSET, repo: CUSTOM_REPO, upstream: CUSTOM_UPSTREAM}; }
function customJson(value, status = 200) { return new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}}); }
const customPoolKeys = list => (list || []).map(x => String(x.ip) + ':' + Number(x.port || 443));
let customRefreshInFlight = null;
async function refreshBestIPs(env) {
  if (customRefreshInFlight) return {status: 'busy'};
  customRefreshInFlight = customRefreshBestIPs(env);
  try { return await customRefreshInFlight; } finally { customRefreshInFlight = null; }
}
async function customRefreshBestIPs(env) {
  if (!['1','true'].includes(String(env.BESTIP_AUTO || '').toLowerCase())) return {status:'disabled'};
  CUSTOM_ADAPTER.setEnv(env);
  const cfg = await CUSTOM_ADAPTER.load(env), optimizer = cfg.optimizer || {};
  const current = Array.isArray(cfg.preferredIPs) ? cfg.preferredIPs : [];
  const rawSize = Number(env.BESTIP_POOL_SIZE ?? optimizer.count ?? 5);
  const poolSize = Math.max(1, Math.min(20, Number.isFinite(rawSize) ? Math.floor(rawSize) : 5));
  const rawWindow = Number(env.BESTIP_HYSTERESIS_MS ?? 25);
  const hysteresisMs = Math.max(0, Math.min(500, Number.isFinite(rawWindow) ? rawWindow : 25));
  let fresh = [], sourceError = false;
  try { fresh = (await CUSTOM_ADAPTER.candidates(optimizer)).candidates || []; } catch { sourceError = true; }
  const merged = [], seen = new Set();
  for (const x of [...current, ...fresh]) {
    if (!x?.ip) continue;
    const port = Number(x.port || optimizer.port || 443);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const key = String(x.ip) + ':' + port;
    if (seen.has(key)) continue;
    seen.add(key); merged.push({ip: String(x.ip), port});
  }
  if (!merged.length) return {status:'no-candidates', poolSize, sourceError};
  const results = []; let cursor = 0;
  const threads = Math.max(1,Math.min(10,Number(optimizer.threads)||5));
  await Promise.all(Array.from({length:threads}, async () => {
    while (cursor < merged.length) {
      const x = merged[cursor++];
      try { results.push(await CUSTOM_ADAPTER.probe(x.ip,x.port,5000)); } catch { /* failed probes never enter pool */ }
    }
  }));
  const healthy = results.filter(x => x.ok && Number.isFinite(x.latency) && x.latency >= 0).sort((a,b)=>a.latency-b.latency);
  if (!healthy.length) return {status:'no-healthy-candidates', poolSize, tested:merged.length, sourceError};
  const bestLatency = healthy[0].latency;
  const byKey = new Map(healthy.map(x => [String(x.ip)+':'+Number(x.port||443), x]));
  const selected = [], chosen = new Set();
  for (const x of current) {
    if (selected.length >= poolSize) break;
    if (!x?.ip) continue;
    const key = String(x.ip)+':'+Number(x.port||443), r = byKey.get(key);
    if (!r || r.latency > bestLatency+hysteresisMs || chosen.has(key)) continue;
    selected.push(r); chosen.add(key);
  }
  for (const r of healthy) {
    if (selected.length >= poolSize) break;
    const key = String(r.ip)+':'+Number(r.port||443);
    if (chosen.has(key)) continue;
    selected.push(r); chosen.add(key);
  }
  const newIPs = selected.map((x,i)=>({ip:x.ip,port:x.port||443,name:'CF-BEST-'+String(i+1).padStart(2,'0')}));
  if (JSON.stringify(customPoolKeys(current)) === JSON.stringify(customPoolKeys(newIPs))) return {status:'unchanged',poolSize,bestLatency,selected:newIPs.length};
  // Preserve unrelated panel edits and defer if another request has changed the pool.
  const latest = await CUSTOM_ADAPTER.load(env);
  if (JSON.stringify(customPoolKeys(latest.preferredIPs)) !== JSON.stringify(customPoolKeys(current))) return {status:'concurrent-change'};
  latest.preferredIPs = newIPs;
  if (!await CUSTOM_ADAPTER.save(env,latest)) throw new Error('KV binding unavailable; pool was not saved');
  return {status:'updated',poolSize,bestLatency,selected:newIPs.length};
}
export default {
  async fetch(request,env,ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/version') return customJson(customIdentity());
    if (url.pathname === '/_ops/bestip-refresh') {
      const expected = String(env.BESTIP_CRON_TOKEN || '');
      if (request.method !== 'POST' || !expected || request.headers.get('Authorization') !== 'Bearer '+expected) return new Response('Not Found',{status:404});
      try { return customJson({ok:true,data:await refreshBestIPs(env)}); }
      catch { return customJson({ok:false,msg:'Best-IP refresh failed; previous pool retained'},500); }
    }
    const response = await CUSTOM_UPSTREAM_WORKER.fetch(request,env,ctx);
    if (!(response.headers.get('Content-Type') || '').includes('application/json')) return response;
    let body; try { body = await response.clone().json(); } catch { return response; }
    const target = body?.data || body;
    if (!target || !(target.version || target.current)) return response;
    Object.assign(target, {patchset:CUSTOM_PATCHSET,repo:CUSTOM_REPO,upstream:CUSTOM_UPSTREAM});
    const headers = new Headers(response.headers); headers.delete('Content-Length'); headers.delete('ETag');
    return new Response(JSON.stringify(body), {status:response.status,statusText:response.statusText,headers});
  },
  async scheduled(controller,env,ctx) {
    await CUSTOM_UPSTREAM_WORKER.scheduled?.(controller,{...env,BESTIP_AUTO:'0'},ctx);
    await refreshBestIPs(env);
  }
};
