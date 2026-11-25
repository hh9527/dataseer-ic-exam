#!/usr/bin/env node
// 跟着部署的 token 文件走：token 变化时换 Cookie 并重启考官服务；退出时收掉子进程。
import { existsSync, readFileSync, watch, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const port = process.argv[2];
if (!/^[1-9][0-9]{0,4}$/.test(port ?? '') || Number(port)>65535) throw Error('Usage: run-tester.mjs <port> [--deploy-root DIR] [--cwd DIR]');
const {values}=parseArgs({args:process.argv.slice(3),options:{'deploy-root':{type:'string'},cwd:{type:'string'}}});
const root = resolve(values['deploy-root'] ?? join(process.cwd(), '.deploy'));
const tokenFile = join(root, port, 'dsh', 'token');
const cwd = resolve(values.cwd ?? join(root, port, 'dsh', 'demo-ws'));
const ctrlFile = join(root, port, 'tester', '.ctrl');
const exam = fileURLToPath(new URL('./exam.mjs', import.meta.url));
const env = { ...process.env, TESTER_STATE_DIR: join(root, port, 'tester') };

let child;

function stopChild() {
  if (!child) return;
  child.kill('SIGTERM');
  child = undefined;
}

async function auth(url) {
  // token 一次性：直接 GET 带 token 的 URL，从 Set-Cookie 取会话 Cookie。
  const res = await fetch(url, { redirect: 'manual' });
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!cookies.length) throw new Error(`没有拿到 Cookie（HTTP ${res.status}）：token 可能已被使用，重启 run 取新 token`);
  const cookie = cookies[0].split(';')[0];
  const stateFile = join(env.TESTER_STATE_DIR, 'state.json');
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(env.TESTER_STATE_DIR, { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify({ ...state, base: `${url.protocol}//${url.host}`, cookie }, null, 2)}\n`);
}

function startExam() {
  child = spawn(process.execPath, [exam, 'serve', '--port', '0', '--cwd', cwd], { stdio: 'inherit', env });
  child.on('exit', () => { child = undefined; });
}

async function cycle() {
  if (!existsSync(tokenFile)) return;
  const url = new URL(readFileSync(tokenFile, 'utf8').trim());
  stopChild();
  try {
    await auth(url);
  } catch (error) {
    // token 一次性：服务重启后 token 可能已被用过；已有 Cookie 就沿用，不必强求重新认证。
    const stateFile = join(env.TESTER_STATE_DIR, 'state.json');
    const cookie = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')).cookie : undefined;
    if (!cookie) throw error;
    console.log(`! 沿用已有 Cookie（${error.message}）`);
  }
  startExam();
  console.log(`✓ 考官服务已按新 token 启动（${url.host}）`);
}

process.on('SIGINT', () => { stopChild(); process.exit(0); });
process.on('SIGTERM', () => { stopChild(); process.exit(0); });

if (!existsSync(tokenFile)) {
  console.log(`等待 token 文件：${tokenFile}`);
}
// 与部署一致的控制文件：touch 它即重启考官服务。
mkdirSync(join(root, port, 'tester'), { recursive: true });
if (!existsSync(ctrlFile)) writeFileSync(ctrlFile, '');
watch(ctrlFile, () => { cycle().catch((error) => console.error(`✗ ${error.message}`)); });

// token 文件常被原子替换（rename），直接 watch 文件会丢监听；改看目录并比对内容。
let lastToken = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
watch(dirname(tokenFile), () => {
  if (!existsSync(tokenFile)) return;
  const next = readFileSync(tokenFile, 'utf8').trim();
  if (next === lastToken) return;
  lastToken = next;
  cycle().catch((error) => console.error(`✗ ${error.message}`));
});
await cycle().catch((error) => console.error(`✗ ${error.message}`));
console.log('run-tester 已就绪；touch ' + ctrlFile + ' 可重启考官服务，Ctrl-C 退出');
