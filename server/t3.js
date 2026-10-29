import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { run } from './exec.js';
import { DATA, HOME, readJson } from './paths.js';

// T3 Code integration, through T3's own client API (the one its web and mobile apps use): a scoped bearer token
// from `t3 auth session issue`, a WebSocket ticket, then typed requests over /ws. Messages sent this way are
// ordinary T3 messages, so they show up in the T3 desktop app like any other.
const T3_HOME = process.env.T3CODE_HOME || path.join(HOME, '.t3');
const tokenFile = path.join(DATA, 't3-token');
const SCOPES = ['orchestration:read', 'orchestration:operate'];
const events = new EventEmitter();
export const onChange = fn => events.on('change', fn);

let closed = false;
const state = { ws:null, connecting:null, threads:new Map(), projects:new Map(), ready:false, error:'', next:1, waiting:new Map(), retry:0 };

// Tests and other sandboxes run with their own home folder; they must never reach the real T3 Code.
const cli = () => [path.join(T3_HOME, 'bin/t3'), process.env.AGENTSEYE_USER_HOME ? '' : process.env.T3CODE_CLI_PATH].find(p => p && fs.existsSync(p)) || '';
function origin() {
  const rt = readJson(path.join(T3_HOME, 'userdata/server-runtime.json'), null);
  if (!rt?.port) return '';
  try { process.kill(rt.pid, 0); } catch (e) { if (e.code !== 'EPERM') return ''; }
  return `http://127.0.0.1:${rt.port}`;
}
export const installed = () => Boolean(cli());

async function token({ fresh = false } = {}) {
  if (!fresh) { try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch {} }
  const args = ['auth', 'session', 'issue', '--ttl', '90d', '--label', 'AgentsEye', '--token-only'];
  for (const s of SCOPES) args.push('--scope', s);
  const r = await run(cli(), args, { timeout:20000 });
  const tok = r.stdout.trim().split('\n').pop();
  if (!r.ok || !tok) throw new Error('Could not get access to T3 Code.');
  fs.writeFileSync(tokenFile, tok, { mode:0o600 });
  return tok;
}

async function ticket(base) {
  for (const fresh of [false, true]) {
    const tok = await token({ fresh });
    const res = await fetch(`${base}/api/auth/websocket-ticket`, { method:'POST', headers:{ authorization:`Bearer ${tok}` } }).catch(() => null);
    if (res?.ok) return (await res.json()).ticket;
    if (res && res.status !== 401 && res.status !== 403) throw new Error(`T3 Code refused the connection (${res.status}).`);
  }
  throw new Error('T3 Code did not accept AgentsEye’s access token.');
}

function connect() {
  if (closed || state.ws || state.connecting || !installed()) return state.connecting;
  state.connecting = (async () => {
    const base = origin();
    if (!base) throw new Error('T3 Code is not running.');
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?wsTicket=${encodeURIComponent(await ticket(base))}&orchestrationProtocol=2`, { headers:{ 'x-t3-orchestration-protocol':'2' } });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('unexpected-response', (_, res) => reject(new Error(`T3 Code answered ${res.statusCode}.`))); });
    state.ws = ws;
    state.retry = 0;
    ws.on('message', data => receive(JSON.parse(String(data))));
    ws.on('close', () => {
      state.ws = null;
      state.ready = false;
      for (const w of state.waiting.values()) w.reject(new Error('Lost the connection to T3 Code.'));
      state.waiting.clear();
      if (!closed) setTimeout(() => connect()?.catch(() => {}), Math.min(30000, 1000 * 2 ** state.retry++));
    });
    ws.on('error', () => {});
    // The shell subscription is T3's sidebar: a snapshot of every thread, then an update per change.
    send({ _tag:'Request', id:'shell', tag:'orchestration.subscribeShell', payload:{}, headers:[] });
  })().catch(error => {
    state.error = error.message;
    if (!closed) setTimeout(() => connect()?.catch(() => {}), Math.min(30000, 1000 * 2 ** state.retry++));
    throw error;
  }).finally(() => { state.connecting = null; });
  return state.connecting;
}

const send = m => state.ws?.send(JSON.stringify(m));

function receive(m) {
  if (m._tag === 'Ping') return send({ _tag:'Pong' });
  if (m.requestId === 'shell') {
    if (m._tag === 'Chunk') {
      for (const v of m.values || []) {
        if (v.kind === 'snapshot') {
          // The first snapshot after connecting is complete; later ones only carry what changed.
          if (!state.ready) { state.threads = new Map(); state.projects = new Map(); }
          for (const t of v.snapshot.threads || []) state.threads.set(t.id, t);
          for (const t of v.snapshot.archivedThreads || []) state.threads.delete(t.id);
          for (const p of v.snapshot.projects || []) state.projects.set(p.id, p);
          state.ready = true;
          state.error = '';
          events.emit('change', { kind:'snapshot' });
        } else if (v.kind === 'thread.updated' && v.thread) {
          const before = state.threads.get(v.thread.id);
          if (v.location === 'active') state.threads.set(v.thread.id, v.thread); else state.threads.delete(v.thread.id);
          events.emit('change', { kind:'thread', before, after:v.location === 'active' ? v.thread : null });
        } else if (v.kind === 'project.updated' && v.project) state.projects.set(v.project.id, v.project);
      }
      send({ _tag:'Ack', requestId:'shell' });
    }
    return;
  }
  const w = state.waiting.get(m.requestId);
  if (m._tag === 'Exit' && w) {
    state.waiting.delete(m.requestId);
    if (m.exit?._tag === 'Success') w.resolve(m.exit.value);
    else w.reject(new Error(failure(m.exit)));
  }
}

function failure(exit) {
  const find = o => (o && typeof o === 'object' ? (typeof o.message === 'string' ? o.message : Object.values(o).map(find).find(Boolean)) : '');
  return find(exit?.cause) || 'T3 Code refused that.';
}

async function rpc(tag, payload, timeout = 20000) {
  await connect();
  if (!state.ws) throw Object.assign(new Error('T3 Code is not reachable.'), { status:503 });
  const id = `r${state.next++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { state.waiting.delete(id); reject(Object.assign(new Error('T3 Code took too long.'), { status:504 })); }, timeout);
    state.waiting.set(id, { resolve:v => { clearTimeout(timer); resolve(v); }, reject:e => { clearTimeout(timer); reject(Object.assign(e, { status:e.status || 502 })); } });
    send({ _tag:'Request', id, tag, payload, headers:[] });
  });
}
const command = c => rpc('orchestration.dispatchCommand', { commandId:crypto.randomUUID(), ...c });

export function status() {
  return { installed:installed(), connected:Boolean(state.ws) && state.ready, error:state.error };
}

// ---------- Threads ----------
const harnessOf = t => (/codex/i.test(t.providerInstanceId || t.modelSelection?.instanceId || '') ? 'codex' : 'claude');
export function summarize(t) {
  const p = state.projects.get(t.projectId);
  const pending = t.pendingRuntimeRequest;
  // A thread is working while its active run is running, even if more messages are queued behind it.
  const working = t.activityRunStatus === 'running' || ['running', 'queued', 'starting'].includes(t.status);
  const status = pending ? 'waiting' : working ? 'busy' : t.status === 'failed' ? 'failed' : t.status === 'completed' ? 'done' : 'idle';
  const last = t.latestVisibleMessage;
  return {
    source:'t3', id:t.id, harness:harnessOf(t), title:t.title || 'New thread', status, live:status === 'busy' || status === 'waiting',
    cwd:t.worktreePath || p?.workspaceRoot || '', project:p?.title || '', branch:t.branch || '',
    updatedAt:Date.parse(t.updatedAt) || 0, preview:typeof last?.text === 'string' ? last.text.slice(0, 160) : '',
    unread:Boolean(t.lastVisitedAt && t.latestVisibleMessage && Date.parse(t.updatedAt) > Date.parse(t.lastVisitedAt)),
    model:t.modelSelection?.model || '', error:t.lastError || '',
  };
}

// Top-level threads you work with: not archived, not a subagent's thread, not settled away unless still active.
export function threads() {
  connect()?.catch(() => {});
  return [...state.threads.values()]
    .filter(t => !t.archivedAt && !t.deletedAt && t.lineage?.relationshipToParent !== 'subagent')
    .filter(t => !t.settledAt || t.activityRunStatus === 'running' || t.pendingRuntimeRequest)
    .map(summarize)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export const projects = () => [...state.projects.values()].filter(p => !p.deletedAt).map(p => ({ id:p.id, title:p.title, cwd:p.workspaceRoot }));

export async function thread(id) {
  const p = await rpc('orchestration.getThreadProjection', { threadId:id });
  const t = state.threads.get(id) || p.thread;
  const messages = (p.messages || []).filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role:m.role, text:String(m.text || '').replace(/!\[[^\]]*\]\(t3-context:[^)]*\)/g, '🖼 image'), time:m.createdAt }))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  // A question the agent is waiting on, with its options, so the phone can answer it.
  const pendingId = t?.pendingRuntimeRequest?.id || t?.pendingRuntimeRequest?.requestId || (p.runtimeRequests || []).find(r => r.status === 'pending')?.id;
  let question = null;
  if (pendingId) {
    const request = (p.runtimeRequests || []).find(r => r.id === pendingId) || t.pendingRuntimeRequest;
    const item = (p.turnItems || []).find(i => i.requestId === pendingId);
    question = { id:pendingId, kind:request?.kind || 'user_input', canAnswer:(request?.kind || 'user_input') === 'user_input',
      questions:(item?.questions || []).map(q => ({ id:q.id, header:q.header, question:q.question, options:(q.options || []).map(o => o.label) })) };
  }
  const tools = (p.turnItems || []).filter(i => i.type && !['assistant_message', 'user_message', 'message', 'reasoning'].includes(i.type));
  const activity = tools.length && t && summarize(t).status === 'busy' ? (tools.at(-1).title || tools.at(-1).type.replace(/_/g, ' ')) : '';
  return { session:summarize(t ? { ...p.thread, ...t } : p.thread), messages:messages.slice(-200), question, activity };
}

export async function sendMessage(id, text) {
  const t = state.threads.get(id);
  if (t && summarize(t).status === 'busy') throw Object.assign(new Error('The agent is working. Wait for it to finish.'), { status:409 });
  await command({ type:'message.dispatch', createdBy:'user', creationSource:'mobile', threadId:id, messageId:crypto.randomUUID(), text, attachments:[], dispatchMode:{ type:'start_immediately' } });
}

export async function answer(id, requestId, answers) {
  await command({ type:'runtime-request.respond', threadId:id, requestId, answers });
}

export async function stop(id) {
  await command({ type:'thread.stop', threadId:id });
}

// A new thread in a T3 project, started with a first message; it appears in the desktop app straight away.
export async function create({ projectId, text, harness = 'claude' }) {
  if (!state.projects.has(projectId)) throw Object.assign(new Error('Pick a project.'), { status:400 });
  const instance = harness === 'codex' ? 'codex' : 'claudeAgent';
  const recent = [...state.threads.values()].filter(t => (t.providerInstanceId || '') === instance).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const threadId = crypto.randomUUID();
  await command({ type:'thread.create', createdBy:'user', creationSource:'mobile', threadId, projectId,
    title:text.replace(/\s+/g, ' ').slice(0, 60) || 'New thread', modelSelection:recent?.modelSelection || { instanceId:instance, model:instance === 'codex' ? 'gpt-6' : 'claude-opus-5-5' },
    runtimeMode:recent?.runtimeMode || 'full-access', interactionMode:'default', branch:null, worktreePath:null });
  await command({ type:'message.dispatch', createdBy:'user', creationSource:'mobile', threadId, messageId:crypto.randomUUID(), text, attachments:[], dispatchMode:{ type:'start_immediately' } });
  return { id:threadId };
}

export function boot() { if (installed()) connect()?.catch(() => {}); }
export function close() { closed = true; state.ws?.close(); }
