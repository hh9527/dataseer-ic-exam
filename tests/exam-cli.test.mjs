import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
const root=new URL('../',import.meta.url),cli=fileURLToPath(new URL('tools/exam.mjs',root));
const run=(...args)=>spawnSync(process.execPath,[cli,...args],{cwd:'/',encoding:'utf8'});
const section=(file,name)=>readFileSync(new URL(file,root),'utf8').split(`## ${name}\n`)[1].split(/^## /m)[0].trim();
test('lists the complete corpus from an unrelated working directory',()=>{
 const result=run('list','--json');assert.equal(result.status,0,result.stderr);
 const questions=JSON.parse(result.stdout);
 assert.equal(questions.length,142);assert.equal(new Set(questions.map(q=>q.id)).size,142);
 assert(questions.some(q=>q.id==='T1-018'));assert(questions.some(q=>q.id==='C1-102'));
});
test('preserves the flawed task and keeps examiner notes private',()=>{
 const result=run('ask','--question','A2-004','--dry-run');assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout.trim(),`任务 A2-004：${section('questions/A2/A2-004.md','任务')}`);
 assert.match(result.stdout,/30MB/);assert.doesNotMatch(result.stdout,/考核要点|瑕疵题|30%/);
});
test('uses the exact finalized opening and follow-up wording',()=>{
 const opening=run('ask','--opening','--dry-run');assert.equal(opening.status,0,opening.stderr);
 assert.equal(opening.stdout.trim(),readFileSync(new URL('开场白.md',root),'utf8').trim());
 const step=run('ask','--question','T1-016','--step','2','--dry-run');assert.equal(step.status,0,step.stderr);
 assert.equal(step.stdout.trim(),section('questions/T1/T1-016.md','追问 2'));
 assert.doesNotMatch(step.stdout,/^任务 /);
});
test('rejects unknown tasks and unspecified service ports',()=>{
 assert.notEqual(run('ask','--question','A1-999','--dry-run').status,0);
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('tools/run-tester.mjs',root))],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/Usage: run-tester/);
});
