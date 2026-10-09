import fs from 'node:fs';import {parse} from 'acorn';
const code=fs.readFileSync(process.argv[2]||'CFNext 明文版.js','utf8');
const ast=parse(code,{sourceType:'module',ecmaVersion:'latest'});
const declarations=ast.body.flatMap(n=>n.type==='VariableDeclaration'?n.declarations:[]);
for(const [name,value] of [['CUSTOM_PATCHSET','stable-bestip-v2'],['CUSTOM_REPO','wenxin1221-design/CFNext'],['UPDATE_REPO','wenxin1221-design/CFNext']]) {
 const d=declarations.filter(n=>n.id.name===name);if(d.length!==1||d[0].init.value!==value)throw new Error(`[verify] invalid ${name}`);
}
if(ast.body.filter(n=>n.type==='ExportDefaultDeclaration').length!==1)throw new Error('[verify] duplicate export');
if(!ast.body.some(n=>n.type==='ImportDeclaration'&&n.source.value==='cloudflare:sockets'))throw new Error('[verify] missing socket import');
for(const marker of ['loadBalance:false','count:5','refreshBestIPs','BESTIP_HYSTERESIS_MS','BESTIP_POOL_SIZE','BESTIP_CRON_TOKEN','/_ops/bestip-refresh','CUSTOM_UPSTREAM_WORKER','CUSTOM_ADAPTER','concurrent-change','no-healthy-candidates','id="stPatch"','id="aPatch"'])if(!code.includes(marker))throw new Error(`[verify] missing ${marker}`);
console.log('[verify] stable-bestip-v2 invariants and syntax OK');
