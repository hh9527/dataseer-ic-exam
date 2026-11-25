import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadModel} from '../data/ic/generate.mjs';
const contract=process.env.IC_GENERATION_CONTRACT,catalog=process.env.IC_SOURCE_CATALOG;
assert(contract&&catalog,'Provide IC_GENERATION_CONTRACT and IC_SOURCE_CATALOG');
const temporary=mkdtempSync(join(process.env.TMPDIR||join(homedir(),'.cache/tmp'),'exam-contract-'));
try {
 assert.equal(loadModel(contract,catalog).datasets.length,50);
 assert.throws(()=>loadModel('',''),/Provide --contract and --catalog/);
 const invalid=join(temporary,'catalog.json');writeFileSync(invalid,'{}\n');
 assert.throws(()=>loadModel(contract,invalid),/Stale IC generation contract/);
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../data/ic/generate.mjs',import.meta.url)),'--output',join(temporary,'output')],{cwd:temporary,encoding:'utf8',env:{...process.env,IC_GENERATION_CONTRACT:'',IC_SOURCE_CATALOG:''}});
 assert.notEqual(result.status,0);assert.match(result.stderr,/Provide --contract and --catalog/);
 console.log('Contract inputs: explicit paths, catalog digest and missing-input rejection passed');
} finally {rmSync(temporary,{recursive:true,force:true});}
