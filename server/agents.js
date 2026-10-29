import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { run, shellQuote } from './exec.js';
import { HOME } from './paths.js';
import { safePath } from './files.js';
import { openWindow } from './terminal.js';
import { nameOf } from './names.js';

const claudeDir = () => path.join(HOME, '.claude');
const codexDir = () => path.join(HOME, '.codex', 'sessions');
const ID = /^[0-9a-f][0-9a-f-]{20,63}$/i;

function readHead(file, bytes = 256 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, bytes, 0)).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function readTail(file, bytes = 2 * 1024 * 1024) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    // Drop the first, probably partial, line when we started mid-file.
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}
const lines = text => text.split('\n').flatMap(line => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const clip = (text, n = 140) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Claude Code writes ~/.claude/sessions/<pid>.json for every running session, including its idle/busy/waiting status.
export function claudeLive() {
  const dir = path.join(claudeDir(), 'sessions');
  const live = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /^\d+\.json$/.test(n)); } catch { return live; }
  for (const name of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (!r.sessionId || !Number.isInteger(r.pid) || !alive(r.pid)) continue;
      // A chat moved from VS Code to Terminal runs in both for a while; the Terminal one is the one we can type into.
      if (live.get(r.sessionId)?.entrypoint === 'cli' && r.entrypoint !== 'cli') continue;
      live.set(r.sessionId, { pid:r.pid, cwd:r.cwd, name:r.name || '', status:r.status || 'open', entrypoint:r.entrypoint || '', startedAt:r.startedAt || null, version:r.version || '' });
    } catch { /* The session may be mid-write. */ }
  }
  return live;
}

// Prompts often start with pasted context; keep the part a person would recognise.
export function cleanTitle(text) {
  return clip(String(text || '')
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^(Caveat|Context handoff[^:]*):.*$/gim, ' ')
    .replace(/[#*_`>]+/g, ' '), 90);
}

// Title, folder and branch for a Claude transcript. Claude rewrites its AI title as the conversation moves on,
// so the newest one (near the end) wins; the head supplies the folder and first prompt. Cached per file version.
const metaCache = new Map();
export function claudeMeta(file) {
  const mtime = fs.statSync(file).mtimeMs;
  const hit = metaCache.get(file);
  if (hit?.mtime === mtime) return hit.meta;
  const meta = { aiTitle:'', prompt:'', cwd:'', branch:'' };
  for (const e of lines(readHead(file, 128 * 1024))) {
    if (e.type === 'ai-title' && e.aiTitle) meta.aiTitle = e.aiTitle;
    if (!meta.cwd && e.cwd) meta.cwd = e.cwd;
    if (!meta.prompt && e.type === 'user' && !e.isMeta) {
      const text = cleanTitle(textOf(e.message?.content));
      if (text) meta.prompt = text;
    }
  }
  for (const e of lines(readTail(file, 96 * 1024))) {
    if (e.type === 'ai-title' && e.aiTitle) meta.aiTitle = e.aiTitle;
    if (e.gitBranch) meta.branch = e.gitBranch;
    if (e.cwd) meta.cwd = e.cwd;
  }
  metaCache.set(file, { mtime, meta });
  return meta;
}

// Subagents (Task/Agent tool) write their own transcripts next to the parent: <session>/subagents/agent-<id>.jsonl,
// with a .meta.json naming their type and job. A finished one ends on an assistant turn with stop_reason end_turn.
const subCache = new Map();
export function claudeSubagents(sessionFile, parentLive = true) {
  const dir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /^agent-[\w-]+\.jsonl$/.test(n)); } catch { return []; }
  return names.map(name => {
    const file = path.join(dir, name);
    const id = name.slice(6, -6);
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
    const key = `${file}:${mtime}`;
    let info = subCache.get(file)?.key === key ? subCache.get(file).info : null;
    if (!info) {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {}
      const tail = lines(readTail(file, 64 * 1024));
      const last = tail.at(-1);
      const lastText = [...tail].reverse().map(e => e.type === 'assistant' ? textOf(e.message?.content) : '').find(Boolean) || '';
      const ended = last?.type === 'assistant' && last.message?.stop_reason === 'end_turn';
      let task = meta.description || '';
      if (!task) { const first = lines(readHead(file, 16 * 1024))[0]; task = cleanTitle(textOf(first?.message?.content)); }
      info = { id, type:meta.agentType || 'agent', task:clip(task, 90), ended, lastText:clip(lastText, 160) };
      subCache.set(file, { key, info });
    }
    const status = info.ended ? 'done' : parentLive && Date.now() - mtime < 120000 ? 'running' : 'stopped';
    return { ...info, status, updatedAt:mtime };
  }).filter(Boolean).sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.updatedAt - a.updatedAt);
}

const summary = subs => ({ total:subs.length, running:subs.filter(s => s.status === 'running').length });

function claudeSessions(limit) {
  const root = path.join(claudeDir(), 'projects');
  const files = [];
  let projects = [];
  try { projects = fs.readdirSync(root); } catch { return []; }
  for (const project of projects) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, project)); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(root, project, name);
      try { files.push({ file, id:name.slice(0, -6), mtime:fs.statSync(file).mtimeMs }); } catch {}
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map(f => {
    let meta = { aiTitle:'', prompt:'', cwd:'', branch:'' };
    try { meta = claudeMeta(f.file); } catch {}
    return { harness:'claude', id:f.id, file:f.file, updatedAt:f.mtime, title:meta.aiTitle || meta.prompt || '(untitled)', cwd:meta.cwd, branch:meta.branch };
  });
}

// Codex rollouts sit in YYYY/MM/DD folders; walking newest-first keeps this cheap.
function codexFiles(limit) {
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes:true }); } catch { return; }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const e of entries) {
      if (found.length >= limit * 3) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) { try { found.push({ file:full, mtime:fs.statSync(full).mtimeMs }); } catch {} }
    }
  };
  walk(codexDir(), 0);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function codexSessions(limit) {
  return codexFiles(limit).map(f => {
    let id = path.basename(f.file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1] || path.basename(f.file, '.jsonl');
    let cwd = '';
    let title = '';
    let entrypoint = '';
    try {
      for (const entry of lines(readHead(f.file))) {
        if (entry.type === 'session_meta') { id = entry.payload?.id || id; cwd = entry.payload?.cwd || ''; entrypoint = { codex_vscode:'codex-vscode', 'T3 Code':'t3' }[entry.payload?.originator] || ''; }
        if (!title && entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'user') {
          const text = cleanTitle(textOf(entry.payload.content));
          if (text) title = text;
        }
      }
    } catch {}
    return { harness:'codex', id, file:f.file, updatedAt:f.mtime, title:title || '(untitled)', cwd, entrypoint };
  });
}

// A running codex process keeps its rollout file open; lsof links the two.
async function codexLive() {
  const ps = await run('/bin/ps', ['-axo', 'pid=,comm=']);
  const pids = ps.stdout.split('\n').map(l => l.trim().match(/^(\d+)\s+(.+)$/)).filter(m => m && path.basename(m[2]) === 'codex').map(m => m[1]);
  const live = new Map();
  if (!pids.length) return live;
  const result = await run('/usr/sbin/lsof', ['-nP', '-F', 'pn', '-p', pids.join(',')], { timeout:8000 });
  let pid = null;
  for (const line of result.stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && line.endsWith('.jsonl') && line.includes('/.codex/sessions/')) live.set(line.slice(1), pid);
  }
  return live;
}

export async function sessions({ limit = 40 } = {}) {
  const claudeRunning = claudeLive();
  const codexRunning = await codexLive();
  const list = [...claudeSessions(limit), ...codexSessions(limit)];
  for (const s of list) {
    if (s.harness === 'claude' && claudeRunning.has(s.id)) {
      const live = claudeRunning.get(s.id);
      Object.assign(s, { live:true, pid:live.pid, status:live.status, cwd:s.cwd || live.cwd, entrypoint:live.entrypoint });
      claudeRunning.delete(s.id);
    }
    if (s.harness === 'claude' && s.file) s.subagents = summary(claudeSubagents(s.file, Boolean(s.live)));
    if (s.harness === 'codex' && codexRunning.has(s.file)) Object.assign(s, { live:true, pid:codexRunning.get(s.file), status:'open' });
  }
  // A brand-new Claude session may not have a transcript yet.
  // Live sessions whose transcript is older than the recent window, or not written yet.
  for (const [id, live] of claudeRunning) {
    const file = findFile('claude', id);
    let meta = { aiTitle:'', prompt:'', cwd:live.cwd, branch:'' };
    try { if (file) meta = claudeMeta(file); } catch {}
    list.push({ harness:'claude', id, file, updatedAt:file ? fs.statSync(file).mtimeMs : live.startedAt || Date.now(), title:meta.aiTitle || meta.prompt || 'New session', cwd:meta.cwd || live.cwd, branch:meta.branch, live:true, pid:live.pid, status:live.status, entrypoint:live.entrypoint, subagents:file ? summary(claudeSubagents(file, true)) : undefined });
  }
  for (const s of list) s.name = nameOf(s.harness, s.id);
  // Codex writes a new log file each time a conversation is resumed, all with the same id: keep one entry,
  // live if any of its files is open, with the newest activity.
  const merged = new Map();
  for (const s of list) {
    const key = `${s.harness}:${s.id}`;
    const prev = merged.get(key);
    if (!prev) { merged.set(key, s); continue; }
    const keep = (s.live && !prev.live) || (s.live === prev.live && s.updatedAt > prev.updatedAt) ? s : prev;
    merged.set(key, { ...keep, live:prev.live || s.live, updatedAt:Math.max(prev.updatedAt, s.updatedAt), title:keep.title !== '(untitled)' ? keep.title : (prev.title !== '(untitled)' ? prev.title : s.title) });
  }
  return [...merged.values()].sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || b.updatedAt - a.updatedAt).map(({ file, ...s }) => s);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => ['text', 'input_text', 'output_text'].includes(c.type)).map(c => c.text).join('\n');
}

function toolSummary(name, input = {}) {
  const value = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || '';
  return `${name}${value ? `: ${clip(Array.isArray(value) ? value.join(' ') : value, 300)}` : ''}`;
}

export function parseClaude(text, { sidechain = false } = {}) {
  const out = [];
  for (const e of lines(text)) {
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isMeta || (e.isSidechain && !sidechain)) continue;
    const content = e.message?.content;
    const time = e.timestamp;
    if (typeof content === 'string') { if (!content.startsWith('<')) out.push({ role:e.type, text:content, time }); continue; }
    for (const block of content || []) {
      if (block.type === 'text' && block.text && !block.text.startsWith('<')) out.push({ role:e.type, text:block.text, time });
      else if (block.type === 'tool_use') out.push({ role:'tool', text:toolSummary(block.name, block.input), time });
    }
  }
  return out;
}

export function parseCodex(text) {
  const out = [];
  for (const e of lines(text)) {
    const p = e.payload;
    if (e.type !== 'response_item' || !p) continue;
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const t = textOf(p.content);
      if (t && !t.startsWith('<')) out.push({ role:p.role, text:t, time:e.timestamp });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let args = {};
      try { args = JSON.parse(p.arguments || '{}'); } catch { args = { command:p.input || p.arguments }; }
      out.push({ role:'tool', text:toolSummary(p.name, args), time:e.timestamp });
    }
  }
  return out;
}

function findFile(harness, id) {
  if (!ID.test(id)) return null;
  if (harness === 'claude') {
    const root = path.join(claudeDir(), 'projects');
    try {
      for (const project of fs.readdirSync(root)) {
        const file = path.join(root, project, `${id}.jsonl`);
        if (fs.existsSync(file)) return file;
      }
    } catch {}
    return null;
  }
  if (harness === 'codex') return codexFiles(500).find(f => f.file.endsWith(`${id}.jsonl`))?.file || null;
  return null;
}

export function transcript(harness, id, cwd, { agent = '', max = 200 } = {}) {
  let file = findFile(harness, id);
  if (!file) return [];
  if (agent) {
    if (harness !== 'claude' || !/^[\w-]{4,64}$/.test(agent)) return [];
    file = path.join(file.replace(/\.jsonl$/, ''), 'subagents', `agent-${agent}.jsonl`);
    if (!fs.existsSync(file)) return [];
  }
  const text = readTail(file);
  const messages = (harness === 'claude' ? parseClaude(text, { sidechain:Boolean(agent) }) : parseCodex(text)).slice(-max);
  // Replies that mention a file in the project get a download button for it.
  for (const m of messages) {
    if (m.role !== 'assistant' || !cwd) continue;
    const found = new Set();
    for (const token of m.text.match(/[\w./~-]+\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|m4a|pdf|csv|md|txt|docx|xlsx|pptx|zip|html)\b/gi) || []) {
      const rel = token.replace(/^~\//, `${HOME}/`);
      const real = safePath(cwd, path.isAbsolute(rel) ? path.relative(cwd, rel) : rel);
      if (real) found.add(path.relative(fs.realpathSync(cwd), real));
    }
    if (found.size) m.files = [...found].slice(0, 6);
  }
  return messages;
}

// One session by id, whether or not it is in the recent list.
export async function findSession(harness, id) {
  if (!ID.test(String(id))) throw Object.assign(new Error('Bad session id.'), { status:400 });
  const file = findFile(harness, id);
  const session = { harness, id, title:'(untitled)', cwd:'', branch:'', updatedAt:file ? fs.statSync(file).mtimeMs : Date.now(), live:false, name:nameOf(harness, id) };
  if (file && harness === 'claude') {
    try { const m = claudeMeta(file); Object.assign(session, { title:m.aiTitle || m.prompt || '(untitled)', cwd:m.cwd, branch:m.branch }); } catch {}
  } else if (file) {
    try { for (const e of lines(readHead(file))) if (e.type === 'session_meta') session.cwd = e.payload?.cwd || ''; } catch {}
    session.title = codexSessions(500).find(s => s.id === id)?.title || session.title;
  }
  if (harness === 'claude') {
    const live = claudeLive().get(id);
    if (live) Object.assign(session, { live:true, pid:live.pid, status:live.status, cwd:session.cwd || live.cwd, entrypoint:live.entrypoint });
    session.subagents = file ? claudeSubagents(file, session.live) : [];
  } else if (file) {
    const pid = (await codexLive()).get(file);
    if (pid) Object.assign(session, { live:true, pid, status:'open' });
  }
  if (!file && !session.live) throw Object.assign(new Error('Session not found.'), { status:404 });
  return session;
}

// Folders people work in, newest first, for the "new session" picker.
export function projects(list) {
  const seen = new Set();
  return list.map(s => s.cwd).filter(cwd => cwd && !seen.has(cwd) && seen.add(cwd) && fs.existsSync(cwd)).slice(0, 12);
}

// Opens a Terminal.app window so the session is visible on the Mac; macOS asks once for Automation permission.
async function openTerminal(command) {
  const r = await openWindow(command);
  if (!r.ok) throw Object.assign(new Error(r.err || 'Could not open Terminal'), { status:500 });
}

const MODEL = /^[\w.:\[\]-]{1,64}$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// Flags shared by new sessions and copies: model, permission mode and (Claude only) a display name.
function options(harness, { model = '', skipPermissions = false, name = '' } = {}) {
  const flags = [];
  if (model && model !== 'default') {
    if (!MODEL.test(model)) throw fail('That model name looks wrong.');
    flags.push(harness === 'claude' ? `--model ${shellQuote(model)}` : `-m ${shellQuote(model)}`);
  }
  if (skipPermissions) flags.push(harness === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox');
  if (name && harness === 'claude') flags.push(`-n ${shellQuote(String(name).slice(0, 80))}`);
  return flags.join(' ');
}

function folder(cwd) {
  const dir = path.resolve(String(cwd || '').replace(/^~(?=$|\/)/, HOME));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw fail('Folder does not exist.');
  return dir;
}

export async function resume(harness, id, cwd, text = '') {
  if (!ID.test(id)) throw fail('Bad session id.');
  const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  const cli = { claude:`claude --resume ${shellQuote(id)}`, codex:`codex resume ${shellQuote(id)} --no-alt-screen` }[harness];
  if (!cli) throw fail('Unknown harness.');
  await openTerminal(`cd ${shellQuote(dir)} && ${cli}${text ? ` ${shellQuote(text)}` : ''}`);
}

// Claude takes the new session's id up front, so the phone can open it straight away; Codex's id is found
// afterwards by watching for its new log file (see findNew).
export async function start(harness, cwd, prompt, opts = {}) {
  const dir = folder(cwd);
  const startedAt = Date.now();
  const flags = options(harness, opts);
  const text = prompt ? ` ${shellQuote(prompt)}` : '';
  if (harness === 'claude') {
    const id = crypto.randomUUID();
    await openTerminal(`cd ${shellQuote(dir)} && claude --session-id ${id} ${flags}${text}`);
    return { harness, id, cwd:dir, startedAt };
  }
  if (harness !== 'codex') throw fail('Unknown harness.');
  await openTerminal(`cd ${shellQuote(dir)} && codex --no-alt-screen ${flags}${text}`);
  return { harness, id:null, cwd:dir, startedAt };
}

// A copy carries the whole conversation into a new session, so a session that is open in another app
// (VS Code, T3...) can be continued from the phone without two programs writing to the same conversation.
export async function fork(harness, id, cwd, text = '', opts = {}) {
  if (!ID.test(id)) throw fail('Bad session id.');
  const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  const startedAt = Date.now();
  const flags = options(harness, opts);
  const msg = text ? ` ${shellQuote(text)}` : '';
  if (harness === 'claude') {
    const newId = crypto.randomUUID();
    await openTerminal(`cd ${shellQuote(dir)} && claude --resume ${shellQuote(id)} --fork-session --session-id ${newId} ${flags}${msg}`);
    return { harness, id:newId, cwd:dir, startedAt };
  }
  if (harness !== 'codex') throw fail('Unknown harness.');
  await openTerminal(`cd ${shellQuote(dir)} && codex fork ${shellQuote(id)} --no-alt-screen ${flags}${msg}`);
  return { harness, id:null, cwd:dir, startedAt };
}

// The session a start or fork created, once its CLI has written something.
export async function findNew(harness, cwd, since, id) {
  if (harness === 'claude') {
    if (!ID.test(String(id))) throw fail('Bad session id.');
    const live = claudeLive().get(id);
    return live || findFile('claude', id) ? { id } : { id:null };
  }
  for (const s of codexSessions(20)) {
    if (s.updatedAt >= since - 2000 && (!cwd || s.cwd === cwd)) {
      const created = fs.statSync(s.file).birthtimeMs;
      if (created >= since - 2000) return { id:s.id };
    }
  }
  return { id:null };
}

// Ends a running agent: a polite SIGTERM first (it saves its transcript), SIGKILL if it is still there after 4 s.
export async function stop(pid) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw fail('Bad process.');
  const ps = await run('/bin/ps', ['-o', 'comm=', '-p', String(pid)]);
  if (!['claude', 'codex', 'node'].includes(path.basename(ps.stdout.trim()))) throw fail('That process is not an agent.', 409);
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  setTimeout(() => { if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }, 4000).unref();
}
