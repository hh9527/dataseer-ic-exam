#!/usr/bin/env node
// 考官工具：服务维护单个会话的状态机，ask 发问、submit 澄清，越界立即报错。
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const STATE_DIR = process.env.TESTER_STATE_DIR ?? join(process.cwd(), '.deploy', 'tester');
const STATE_FILE = join(STATE_DIR, 'state.json');
const PORT_FILE = join(STATE_DIR, 'exam.port');
const PID_FILE = join(STATE_DIR, 'exam.pid');
const PARAM = { 'session/list': '_request' };

const help = `exam — 考官工具

  exam serve --port 0 --cwd <工作区>   前台服务（一般由 run-tester 拉起）
  exam new-session [--clear]           放弃旧会话，新建一个
  exam list [--json]                   列出题目（题号 / 类型 / 难度 / 步数 / 标题）
  exam ask --opening                   发定稿开场白（开场白.md）
  exam ask --question T1-001              发题面，自动加「任务 T1-001：」前缀
  exam ask --question T1-016 --step 2  发第 2 步追问（原样发出，不加前缀）
  exam ask "<文本>" | --from <文件>     发任意文本
  exam ask ... --dry-run               只打印将要发出的内容，不发送
  exam submit --select "1;2" | "文本"   澄清；多个问题用分号按顺序分段
  exam approve allow | reject            回应审批请求
  exam wait [--timeout 秒]             继续等本轮结果
`;

function args(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {});
const saveState = (s) => { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, `${JSON.stringify(s, null, 2)}\n`); };

async function rpc(state, method, body) {
  const param = PARAM[method] ?? 'request';
  const res = await fetch(`${state.base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: state.cookie ?? '' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { [param]: body } } }),
  });
  if (res.status === 401) throw new Error('401 未认证');
  const json = JSON.parse(await res.text());
  if (!json.result?.ok) throw new Error(`${method}: ${json.result?.error?.code ?? 'unknown'} ${json.result?.error?.message ?? ''}`);
  return json.result.value;
}

const textOf = (ev) => {
  const content = ev?.data?.message?.content ?? ev?.data?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'text').map((p) => p.text).join('');
  return '';
};

function findQuestions(node) {
  const queue = [node];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.questions) && item.questions.length && item.questions[0]?.id) return item.questions;
    for (const value of Object.values(item)) if (value && typeof value === 'object') queue.push(value);
  }
  return undefined;
}

// 审批是「带固定动作的阻塞请求」：客户端监听 approval/request，返回审批结论字符串。
// 结论词表由宿主定义：allowed-once / rejected（另有 cancelled、unavailable 用于异常路径）。
function findApproval(node) {
  const queue = [node];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== 'object') continue;
    if (item.toolName) {
      return {
        toolName: String(item.toolName),
        callId: item.callId ?? null,
        reason: item.reason ?? item.displayReason ?? '',
      };
    }
    for (const value of Object.values(item)) if (value && typeof value === 'object') queue.push(value);
  }
  return undefined;
}

// 交给调用方看的形状：只暴露「是什么、要我决定什么」，不带投递用的内部字段。
function publicItem(item) {
  if (item.kind === 'question') return { kind: 'question', questions: item.questions };
  return { kind: 'approval', toolName: item.toolName, reason: item.reason };
}

// ── 服务 ───────────────────────────────────────────────────────────────────────

async function serve(flags, state) {
  if (!state.base) throw new Error('尚未认证');
  const cwd = flags.cwd ?? state.cwd;
  if (!cwd) throw new Error('需要 --cwd');

  // 状态机：none → idle → running → pending → running → idle
  let sessionId;
  let phase = 'none';
  // 所有阻塞型交互（澄清、审批）统一进这个队列，由考官逐条决定，工具不预设立场。
  const pendingInputs = [];
  let seqAtTurnStart = 0;
  let lastReply = '';
  let generation = 0;
  const dumpApproval = (payload) => {
    try { appendFileSync(join(STATE_DIR, 'approval-dump.jsonl'), `${JSON.stringify(payload)}\n`); } catch {}
  };

  // 事件流必须能自愈：DSH 重启会关掉旧的 WebSocket，不重连就再也收不到澄清请求。
  let ws;
  let stopping = false;
  const onFrame = (m) => {
    let frame; try { frame = JSON.parse(String(m.data)); } catch { return; }
    const value = frame?.value;
    if (!value) return;
    if (value.type === 'ready') { ws.__clientId = value.clientId; return; }
    if (value.type !== 'waterfall') return;
    if (!sessionId) return;
    // agentId 即会话号：别的会话的提问一律无视。
    const eventSession = value.agentId ?? value.request?.agentId;
    if (eventSession !== undefined && String(eventSession) !== sessionId) return;
    if (value.event === 'user-questions/request') {
      const questions = findQuestions(value.request);
      if (!questions) return;
      if (pendingInputs.some((i) => i.eventId === value.eventId)) return;
      pendingInputs.push({ kind: 'question', eventId: value.eventId, clientId: ws.__clientId, questions });
      phase = 'pending';
      return;
    }
    if (value.event === 'approval/request') {
      const view = findApproval(value.request ?? value);
      dumpApproval({ at: new Date().toISOString(), event: value.event, view: view ?? null, raw: value.request ?? null });
      if (!view) return;
      if (pendingInputs.some((i) => i.eventId === value.eventId)) return;
      pendingInputs.push({ kind: 'approval', eventId: value.eventId, clientId: ws.__clientId, toolName: view.toolName, reason: view.reason });
      return;
    }
    if (value.event === 'turn/end') {
      // 轮次已结束，任何还挂着的待办都已过期（被别处应答或随轮次作废）。
      if (pendingInputs.length) {
        dumpApproval({ at: new Date().toISOString(), stale: pendingInputs.map(publicItem), reason: 'turn/end' });
        pendingInputs.length = 0;
      }
      phase = 'idle';
    }
  };
  const openEvents = () => {
    if (stopping) return;
    // 每次重连都重新读 state：run-tester 可能已换过 Cookie。
    const fresh = loadState();
    const socket = new WebSocket(`${fresh.base.replace(/^http/, 'ws')}/api/remote.mux`, { headers: { cookie: fresh.cookie ?? '' } });
    ws = socket;
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'open', streamId: randomUUID(), endpoint: '$events', payload: { args: {} } })));
    socket.addEventListener('message', onFrame);
    socket.addEventListener('error', () => { try { socket.close(); } catch {} });
    socket.addEventListener('close', () => { if (!stopping) setTimeout(openEvents, 1000); });
  };
  openEvents();
  process.on('SIGTERM', () => { stopping = true; try { ws?.close(); } catch {} });

  const sessionView = async () => {
    const items = (await rpc(state, 'session/list', {})).items ?? [];
    const item = items.find((i) => i.sessionId === sessionId);
    if (!item) return { running: false, seq: 0, reply: '' };
    const page = await rpc(state, 'session/page', { address: { kind: 'session', sessionId }, throughSeq: item.projections.asOfSeq, maxMessages: 400 });
    const replies = (page.records ?? []).map((r) => r.event).filter((ev) => ev?.type === 'assistant/message').map(textOf).filter(Boolean);
    return { running: Boolean(item.running), seq: item.projections.asOfSeq, reply: replies.at(-1) ?? '' };
  };

  // 结束判定以会话真实状态为准：turn/end 不在事件流里，不能等它。
  const waitSettled = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    const myGeneration = generation;
    for (;;) {
      if (generation !== myGeneration) return { status: 'aborted' };
      if (pendingInputs.length) return { status: 'pending', items: pendingInputs.map(publicItem) };
      const view = await sessionView();
      if (!view.running && view.seq > seqAtTurnStart) {
        // 会话已经停下，但待办还非空：这些事件已被宿主丢弃，不能当作还在等。
        if (pendingInputs.length) {
          dumpApproval({ at: new Date().toISOString(), stale: pendingInputs.map(publicItem), reason: 'turn-settled' });
          pendingInputs.length = 0;
        }
        phase = 'idle';
        return { status: 'done', reply: view.reply };
      }
      if (Date.now() > deadline) return { status: 'waiting' };
      await sleep(1000);
    }
  };

  const answerPending = async (text, select) => {
    const item = pendingInputs.find((i) => i.kind === 'question');
    if (!item) throw new Error('当前没有待澄清的问题');
    const { eventId, clientId, questions } = item;
    const labelsOf = (q) => (q.options ?? []).map((o) => o.label ?? String(o));
    const pick = (q, choice) => {
      const labels = labelsOf(q);
      const picked = String(choice).split(/[,，]/).map((s) => s.trim()).filter(Boolean).map((part) => {
        const hit = /^\d+$/.test(part) ? labels[Number(part) - 1] : labels.find((l) => l === part) ?? labels.find((l) => l.includes(part));
        if (!hit) throw new Error(`没有匹配的选项：${part}；可选 ${labels.join(' / ')}`);
        return hit;
      });
      if (!q.multiSelect && picked.length > 1) throw new Error(`该问题只能选一个：${labels.join(' / ')}`);
      return picked;
    };
    // 多问题：--select / 文本用分号按问题顺序分段；只有一个问题时整段不拆。
    const partsOf = (value) => {
      const raw = String(value ?? '');
      if (questions.length <= 1) return [raw];
      return raw.split(/[;；]/).map((s) => s.trim());
    };
    const parts = select !== undefined ? partsOf(select) : partsOf(text);
    if (parts.length > questions.length) throw new Error(`给了 ${parts.length} 段，本轮只有 ${questions.length} 个问题`);
    const answers = questions.map((q, index) => {
      const part = parts[index];
      if (select !== undefined) return { id: q.id, selected: part ? pick(q, part) : [] };
      return { id: q.id, selected: [], custom: part ?? '' };
    });
    const res = await fetch(`${state.base}/api/$events/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: state.cookie ?? '' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: '$events/result', payload: { args: { clientId, eventId, outcome: { kind: 'result', value: { answers } } } } }),
    });
    const raw = await res.text().catch(() => '');
    let body;
    try { body = JSON.parse(raw); } catch { body = undefined; }
    if (!res.ok || body?.result?.ok !== true) {
      throw new Error(`回答未被接受（HTTP ${res.status}）：${(body?.result?.error?.message ?? raw).slice(0, 200)}`);
    }
    const index = pendingInputs.indexOf(item);
    if (index < 0) throw new Error('待处理请求已失效');
    pendingInputs.splice(index, 1);
    phase = pendingInputs.some((i) => i.kind === 'question') ? 'pending' : 'running';
  };

  // 审批结论就是宿主 answerer 的返回值：把字符串作为事件结果回投。
  async function answerApproval(decision) {
    if (decision !== 'allow' && decision !== 'reject') throw new Error('approve 需要 allow 或 reject');
    const item = pendingInputs.find((i) => i.kind === 'approval');
    if (!item) throw new Error('当前没有待审批的请求');
    const { eventId, clientId } = item;
    const value = decision === 'allow' ? 'allowed-once' : 'rejected';
    const res = await fetch(`${state.base}/api/$events/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: state.cookie ?? '' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: '$events/result', payload: { args: { clientId, eventId, outcome: { kind: 'result', value } } } }),
    });
    const text = await res.text().catch(() => '');
    dumpApproval({ at: new Date().toISOString(), decision, value, status: res.status, body: text.slice(0, 300) });
    // 检查宿主 RPC 的响应状态。
    let body;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (!res.ok || body?.result?.ok !== true) {
      throw new Error(`审批未被接受（HTTP ${res.status}）：${(body?.result?.error?.message ?? text).slice(0, 200)}`);
    }
    const index = pendingInputs.indexOf(item);
    if (index < 0) throw new Error('待处理请求已失效');
    pendingInputs.splice(index, 1);
  }

  const server = createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const read = (cb) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => cb(JSON.parse(raw || '{}'))); };

    if (req.method === 'GET' && req.url === '/state') return send(200, { sessionId: sessionId ?? null, cwd, phase, pending: pendingInputs.map(publicItem) });

    if (req.method === 'POST' && req.url === '/approve') {
      return read(async ({ decision, timeoutSeconds }) => {
        try {
          if (decision !== 'allow' && decision !== 'reject') return send(400, { error: 'approve 需要 allow 或 reject' });
          await answerApproval(decision);
          send(200, await waitSettled(Math.max(5, Number(timeoutSeconds ?? 180)) * 1000));
        } catch (error) { send(409, { error: String(error?.message ?? error) }); }
      });
    }

    if (req.method === 'POST' && req.url === '/new-session') {
      return read(async ({ clear }) => {
        try {
          if (clear) {
            for (const name of existsSync(cwd) ? readdirSync(cwd) : []) {
              if (name.endsWith('.dari')) rmSync(join(cwd, name), { force: true });
            }
          }
          const created = await rpc(state, 'session/create', { cwd, agentPreset: 'dari' });
          sessionId = created.sessionId;          // 放弃旧会话
          generation += 1;                        // 旧一轮的等待一并作废
          pendingInputs.length = 0; phase = 'idle'; seqAtTurnStart = 0; lastReply = '';
          saveState({ ...state, cwd, sessionId });
          send(200, { sessionId });
        } catch (error) { send(409, { error: String(error?.message ?? error) }); }
      });
    }

    if (req.method === 'POST' && req.url === '/ask') {
      return read(async ({ text, timeoutSeconds }) => {
        try {
          if (!sessionId) throw new Error('还没有会话；先 new-session');
          if (phase === 'running' && !pendingInputs.length) {
            const view = await sessionView();
            if (!view.running) phase = 'idle';
          }
          if (phase !== 'idle') {
            const blocked = pendingInputs.length
              ? pendingInputs.map((i) => (i.kind === 'approval' ? `等待审批 ${i.toolName}` : '等待澄清')).join(' / ')
              : '考生作答中';
            throw new Error(`当前不能发问（${blocked}）`);
          }
          if (!text?.trim()) throw new Error('ask 需要文本');
          const view = await sessionView();
          seqAtTurnStart = view.seq;
          phase = 'running';
          await rpc(state, 'session/prompt', { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' });
          send(200, await waitSettled(Math.max(5, Number(timeoutSeconds ?? 180)) * 1000));
        } catch (error) { send(409, { error: String(error?.message ?? error) }); }
      });
    }

    if (req.method === 'POST' && req.url === '/submit') {
      return read(async ({ text, select, timeoutSeconds }) => {
        try {
          if (!pendingInputs.some((i) => i.kind === 'question')) {
            const blocked = pendingInputs.some((i) => i.kind === 'approval') ? '等待审批' : phase === 'running' ? '考生作答中' : '等待发问';
            throw new Error(`当前没有待澄清的问题（${blocked}）`);
          }
          await answerPending(text ?? '', select);
          send(200, await waitSettled(Math.max(5, Number(timeoutSeconds ?? 180)) * 1000));
        } catch (error) { send(409, { error: String(error?.message ?? error) }); }
      });
    }

    if (req.method === 'POST' && req.url === '/wait') {
      return read(async ({ timeoutSeconds }) => {
        try { send(200, await waitSettled(Math.max(5, Number(timeoutSeconds ?? 180)) * 1000)); }
        catch (error) { send(500, { error: String(error?.message ?? error) }); }
      });
    }

    send(404, { error: 'not found' });
  });

  server.listen(Number(flags.port ?? 0), '127.0.0.1', () => {
    const actual = server.address().port;
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(PORT_FILE, String(actual));
    writeFileSync(PID_FILE, String(process.pid));
    console.log(`exam 服务：http://127.0.0.1:${actual}`);
  });
}

// ── 客户端 ─────────────────────────────────────────────────────────────────────

function port() {
  if (!existsSync(PORT_FILE)) throw new Error('没有运行中的考官服务（run-tester 起了吗）');
  return Number(readFileSync(PORT_FILE, 'utf8'));
}

function readFrom(file) {
  let text = readFileSync(file, 'utf8').split(/\r?\n/).filter((line, index) => !(index === 0 && line.startsWith('# '))).join('\n');
  const cut = text.indexOf('## 追问');
  if (cut >= 0) text = text.slice(0, cut);
  return text.trim();
}

// 题目文件按「## 段名」分节：任务 / 进入 / 可澄清点 / 考核要点 / 追问 m。
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function sections(text) {
  const out = {};
  for (const part of text.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    if (nl < 0) out[part.trim()] = '';
    else out[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  return out;
}

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const QUESTION_ROOT = join(ROOT, 'questions');
// 题号形如 T1-001（原有分析卷）、A1-01 / C1-042（扩展卷）。
const QUESTION_ID = /^([A-Z]\d-\d{3})$/;

function walkQuestions(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkQuestions(full));
    else if (entry.name.endsWith('.md') && entry.name.toUpperCase() !== 'README.MD') out.push(full);
  }
  return out;
}

function questionId(file) {
  return basename(file).match(/^([A-Z]\d-\d{3})/)?.[1];
}

function listQuestions(flags) {
  const rows = walkQuestions(QUESTION_ROOT).map((file) => {
    const text = readFileSync(file, 'utf8');
    const fm = frontmatter(text);
    const steps = (text.match(/^## 追问 \d+$/gm) ?? []).length;
    const rel = file.slice(QUESTION_ROOT.length + 1);
    if (fm.steps !== undefined && Number(fm.steps) !== steps) {
      console.error(`! ${rel}: frontmatter steps=${fm.steps}，实际 ${steps} 个追问段`);
    }
    return {
      id: questionId(file) ?? rel,
      title: fm.title ?? '',
      type: fm.type ?? '',
      difficulty: Number(fm.difficulty ?? 0),
      steps,
    };
  }).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  if (flags.json) return console.log(JSON.stringify(rows, null, 2));
  const pad = (value, width) => String(value) + ' '.repeat(Math.max(1, width - [...String(value)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)));
  console.log(pad('题号', 7) + pad('类型', 6) + pad('难度', 5) + pad('步数', 5) + '标题');
  for (const r of rows) console.log(pad(r.id, 7) + pad(r.type, 6) + pad(r.difficulty, 5) + pad(r.steps, 5) + r.title);
}

function questionFile(name) {
  const raw = String(name);
  if (existsSync(raw)) return raw;
  const relative = join(QUESTION_ROOT, raw.endsWith('.md') ? raw : `${raw}.md`);
  if (existsSync(relative)) return relative;
  const id = raw.replace(/\.md$/, '');
  if (QUESTION_ID.test(id)) {
    const hit = walkQuestions(QUESTION_ROOT).find((file) => questionId(file) === id);
    if (hit) return hit;
  }
  throw new Error(`找不到题目：${name}（用题号如 T1-001 / A1-01，或 questions 下的相对路径）`);
}

function composeAsk(flags) {
  if (flags.opening) return readFileSync(join(ROOT, '开场白.md'), 'utf8').trim();
  if (!flags.question) return undefined;
  const file = questionFile(String(flags.question));
  const sec = sections(readFileSync(file, 'utf8'));
  if (flags.step !== undefined) {
    const key = `追问 ${flags.step}`;
    if (sec[key] === undefined) throw new Error(`题目里没有「${key}」段，只有：${Object.keys(sec).join(' / ')}`);
    return sec[key];
  }
  if (sec['任务'] === undefined) throw new Error('题目里没有「## 任务」段');
  const id = questionId(file);
  if (!id) throw new Error('题目文件名须以题号开头，如 T1-001 / A1-01');
  const intro = sec['进入'] ? `\n\n${sec['进入']}` : '';
  return `任务 ${id}：${sec['任务']}${intro}`;
}

function report(body, elapsed) {
  if (body.status === 'pending') {
    for (const item of body.items) {
      if (item.kind === 'question') {
        console.log('⟐ 等待你澄清');
        for (const q of item.questions) {
          console.log(`  [${q.id}] ${q.header ?? ''} ${q.question ?? ''}`);
          for (const o of q.options ?? []) console.log(`    - ${o.label ?? o}`);
        }
      } else {
        console.log('⟐ 等待审批');
        console.log(`  [${item.toolName}] ${item.reason ?? ''}`);
        console.log('  用 approve allow / approve reject 决定');
      }
    }
    return;
  }
  if (body.status === 'aborted') {
    console.log('× 会话已更换，本轮作废');
    return;
  }
  if (body.status === 'done') {
    console.log('✓ 本轮结束，等待你发问');
    if (body.reply) console.log(`\n${body.reply}`);
    return;
  }
  console.log(`… 仍在进行（已等待 ${elapsed}s）；用 wait 继续等`);
}

async function call(path, payload, flags) {
  const startedAt = Date.now();
  const res = await fetch(`http://127.0.0.1:${port()}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  report(body, Math.round((Date.now() - startedAt) / 1000));
}

const { flags, pos } = args(process.argv.slice(2));
const [command] = pos;
try {
  if (command === 'list') listQuestions(flags);
  else if (command === 'serve') await serve(flags, loadState());
  else if (command === 'new-session') {
    const res = await fetch(`http://127.0.0.1:${port()}/new-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clear: Boolean(flags.clear) }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    console.log(`✓ 会话已建立 ${body.sessionId}${flags.clear ? '（工作区已清空）' : ''}，等待你发问`);
  } else if (command === 'ask') {
    const text = composeAsk(flags) ?? (flags.from ? readFrom(String(flags.from)) : pos.slice(1).join(' '));
    if (!text) throw new Error('ask 需要文本、--from、--question 或 --opening 之一');
    if (flags['dry-run']) { console.log(text); process.exit(0); }
    await call('/ask', { text, timeoutSeconds: Number(flags.timeout ?? 180) }, flags);
  } else if (command === 'submit') {
    const text = pos.slice(1).join(' ');
    if (!text && flags.select === undefined) throw new Error('submit 需要文本或 --select');
    await call('/submit', { text, select: flags.select, timeoutSeconds: Number(flags.timeout ?? 180) }, flags);
  } else if (command === 'approve') {
    const decision = pos[1] === 'reject' ? 'reject' : pos[1] === 'allow' ? 'allow' : undefined;
    if (!decision) throw new Error('approve 需要 allow 或 reject');
    await call('/approve', { decision, timeoutSeconds: Number(flags.timeout ?? 180) }, flags);
  } else if (command === 'wait') {
    await call('/wait', { timeoutSeconds: Number(flags.timeout ?? 180) }, flags);
  } else console.log(help);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
