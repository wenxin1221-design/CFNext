#!/usr/bin/env node
import fs from 'node:fs';
import {parse} from 'acorn';
import {fileURLToPath} from 'node:url';
const input = process.argv[2] || 'CFNext 明文版.js', output = process.argv[3] || input;
let code = fs.readFileSync(input,'utf8');
const ast = parse(code,{ecmaVersion:'latest',sourceType:'module'});
const edits=[];
function walk(n,visit) { if (!n || typeof n !== 'object') return; if(n.type) visit(n); for(const [k,v] of Object.entries(n)) {if(['start','end'].includes(k))continue; if(Array.isArray(v))v.forEach(x=>walk(x,visit)); else if(v&&typeof v==='object')walk(v,visit);} }
const nodes=[];walk(ast,n=>nodes.push(n));
function one(label,list) {if(list.length!==1)throw new Error(`[patch] expected one ${label}; found ${list.length}`);return list[0];}
const key=p=>p.key?.name ?? p.key?.value;
const hasKey=(n,k)=>{let yes=false;walk(n,x=>{if(x.type==='Property'&&key(x)===k)yes=true;});return yes;};
const hasLiteral=(n,s)=>{let yes=false;walk(n,x=>{if(x.type==='Literal'&&x.value===s)yes=true;});return yes;};
const hasMember=(n,s)=>{let yes=false;walk(n,x=>{if(x.type==='MemberExpression'&&(x.property.name??x.property.value)===s)yes=true;});return yes;};
const funcs=ast.body.filter(x=>x.type==='FunctionDeclaration');
const load=one('config loader',funcs.filter(n=>hasMember(n,'U')&&hasMember(n,'uuid')&&hasMember(n,'CF_ACCOUNT_ID')));
const save=one('config writer',funcs.filter(n=>hasLiteral(n,'config')&&hasMember(n,'put')&&n.params.length===2&&!hasMember(n,'get')));
const candidates=one('candidate collector',funcs.filter(n=>hasKey(n,'candidates')&&hasKey(n,'presetErr')&&hasKey(n,'customErr')));
const probe=one('latency probe',funcs.filter(n=>hasKey(n,'latency')&&hasKey(n,'ok')&&hasMember(n,'opened')&&n.params.length===3));
one('socket import',ast.body.filter(n=>n.type==='ImportDeclaration'&&n.source.value==='cloudflare:sockets'));
const version=one('VERSION declaration',nodes.filter(n=>n.type==='VariableDeclarator'&&n.id.name==='VERSION'));
if(version.init.type!=='Literal'||!/^\d+\.\d+\.\d+$/.test(version.init.value))throw new Error('[patch] unsupported VERSION');
if(Number(version.init.value.split('.')[0])!==2 || Number(version.init.value.split('.')[1])<6)throw new Error(`[patch] upstream ${version.init.value} requires adapter review`);
const repo=one('UPDATE_REPO',nodes.filter(n=>n.type==='VariableDeclarator'&&n.id.name==='UPDATE_REPO'&&n.init.value==='PAICNI/CFNext'));
edits.push([repo.init.start,repo.init.end,JSON.stringify('wenxin1221-design/CFNext')]);
const config=one('default config',nodes.filter(n=>n.type==='ObjectExpression'&&['uuid','optimizer','preferredIPs','loadBalance'].every(k=>n.properties.some(p=>key(p)===k))));
const lb=config.properties.find(p=>key(p)==='loadBalance');edits.push([lb.value.start,lb.value.end,'false']);
const opt=config.properties.find(p=>key(p)==='optimizer').value;
const count=one('optimizer count',opt.properties.filter(p=>key(p)==='count'));edits.push([count.value.start,count.value.end,'5']);
const exp=one('default worker export',ast.body.filter(n=>n.type==='ExportDefaultDeclaration'&&n.declaration.type==='ObjectExpression'));
const fetch=one('fetch handler',exp.declaration.properties.filter(p=>key(p)==='fetch')).value;
const inner=fetch.body.callee;
if(inner?.type!=='FunctionExpression'||inner.params.length!==2)throw new Error('[patch] unsupported fetch adapter');
const assign=inner.body.body[0]?.expression;
if(assign?.type!=='AssignmentExpression'||assign.left.type!=='Identifier'||assign.right.name!==inner.params[1].name)throw new Error('[patch] unsupported runtime environment initialization');
const envVar=assign.left.name;
one('runtime environment binding',ast.body.flatMap(n=>n.type==='VariableDeclaration'?n.declarations:[]).filter(n=>n.id.name===envVar));
one('scheduled handler',exp.declaration.properties.filter(p=>key(p)==='scheduled'));
edits.push([exp.start,exp.declaration.start,'const CUSTOM_UPSTREAM_WORKER = ']);
for(const [start,end,value] of edits.sort((a,b)=>b[0]-a[0])) code=code.slice(0,start)+value+code.slice(end);
// UI remains readable upstream. Keep uniqueness checks rather than matching minified identifiers.
const patches=JSON.parse(fs.readFileSync(fileURLToPath(new URL('./ui-patches.json',import.meta.url)),'utf8'));
if(patches.length!==4)throw new Error('[patch] incomplete UI adapter');
for(const [label,search,replacement] of patches) {
 const i=code.indexOf(search);
 if(i<0||code.indexOf(search,i+search.length)>=0)throw new Error(`[patch] changed UI anchor: ${label}`);
 code=code.slice(0,i)+replacement+code.slice(i+search.length);
}
const adapter=`\nconst CUSTOM_ADAPTER = {load:${load.id.name},save:${save.id.name},candidates:${candidates.id.name},probe:${probe.id.name},setEnv: env => {${envVar}=env;}};\n`;
code+=adapter+fs.readFileSync(fileURLToPath(new URL('./runtime.mjs',import.meta.url)),'utf8');
parse(code,{ecmaVersion:'latest',sourceType:'module'});
fs.writeFileSync(output,code);
console.log(`[patch] CFNext ${version.init.value} -> stable-bestip-v2: ${output}`);
