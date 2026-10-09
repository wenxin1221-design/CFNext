import fs from 'node:fs';import {parse} from 'acorn';
const source=fs.readFileSync(process.argv[2]||'CFNext 明文版.js','utf8');
const size=Buffer.byteLength(source);if(size<100000||size>1000000)throw new Error('Unexpected upstream source size');
const ast=parse(source,{sourceType:'module',ecmaVersion:'latest'});
if(!ast.body.some(n=>n.type==='ImportDeclaration'&&n.source.value==='cloudflare:sockets'))throw new Error('Missing socket import');
if(ast.body.filter(n=>n.type==='ExportDefaultDeclaration').length!==1)throw new Error('Expected one worker export');
console.log('[source] syntax, size, socket import and worker export OK');
