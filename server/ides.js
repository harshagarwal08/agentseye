// Chats from editors with their own agents: Cursor and VS Code (GitHub Copilot). Neither offers a way for
// another app to send them messages, so these are read only: you can follow them, and get a ping when they finish.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOME } from './paths.js';

const run = promisify(execFile);
const support = path.join(HOME, 'Library', 'Application Support');
const cursorDb = path.join(support, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const codeStorage = path.join(support, 'Code', 'User', 'workspaceStorage');
const RECENT = 3 * 24 * 3600 * 1000;
const PER_APP = 6;
const mtime = file => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

// Cursor keeps everything in one SQLite file. Read it with the sqlite3 that ships with macOS, read only.
// If Cursor holds a write lock, fall back to a snapshot read rather than wait.
async function sql(query) {
  for (const uri of [`file:${cursorDb}?mode=ro`, `file:${cursorDb}?immutable=1`]) {
    try {
      const { stdout } = await run('/usr/bin/sqlite3', ['-readonly', '-json', uri, query], { maxBuffer:64 * 1024 * 1024, timeout:15000 });
      return stdout.trim() ? JSON.parse(stdout) : [];
    } catch {}
  }
  return [];
}
const quote = s => `'${String(s).replace(/'/g, "''")}'`;

// The file is large and Cursor writes to it constantly while working, so scan it at most every 10 seconds.
let cursorCache = { at:0, checked:0, list:[] };
async function cursorList() {
  const at = mtime(cursorDb);
  if (!at) return [];
  if (at === cursorCache.at || Date.now() - cursorCache.checked < 10000) return cursorCache.list;
  cursorCache.checked = Date.now();
  const rows = await sql(`select substr(key, 14) id, json_extract(value,'$.name') name, json_extract(value,'$.status') status,
    coalesce(json_extract(value,'$.lastUpdatedAt'), json_extract(value,'$.createdAt')) updated
    from cursorDiskKV where key like 'composerData:%' and json_array_length(json_extract(value,'$.fullConversationHeadersOnly')) > 0
    order by updated desc limit 40`);
  const list = rows.map(r => ({
    source:'ide', app:'cursor', harness:'cursor', id:r.id, title:r.name || 'Cursor chat', project:'Cursor',
    status:r.status === 'generating' ? 'busy' : 'done', updatedAt:Number(r.updated) || 0,
  }));
  cursorCache = { at, checked:Date.now(), list };
  return list;
}

async function cursorThread(id) {
  const [head] = await sql(`select json_extract(value,'$.fullConversationHeadersOnly') h from cursorDiskKV where key = ${quote(`composerData:${id}`)}`);
  if (!head) throw Object.assign(new Error('That Cursor chat is gone.'), { status:404 });
  const order = JSON.parse(head.h || '[]').map(b => b.bubbleId);
  const bubbles = await sql(`select substr(key, ${`bubbleId:${id}:`.length + 1}) id, json_extract(value,'$.type') type, json_extract(value,'$.text') text, json_extract(value,'$.createdAt') at
    from cursorDiskKV where key >= ${quote(`bubbleId:${id}:`)} and key < ${quote(`bubbleId:${id};`)}`);
  const byId = new Map(bubbles.map(b => [b.id, b]));
  // Cursor splits one reply into many bubbles around tool calls; join them back into one message.
  const messages = [];
  for (const b of order.map(x => byId.get(x)).filter(b => b && String(b.text || '').trim())) {
    const role = b.type === 1 ? 'user' : 'assistant';
    const prev = messages.at(-1);
    if (prev?.role === 'assistant' && role === 'assistant') { prev.text += `\n\n${b.text.trim()}`; prev.time = b.at; }
    else messages.push({ role, text:b.text.trim(), time:b.at });
  }
  return messages;
}

// VS Code stores each Copilot chat as a JSON file, or as a log of edits to one (.jsonl) in newer versions.
function readCopilot(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) return JSON.parse(raw);
  let state = {};
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let op;
    try { op = JSON.parse(line); } catch { continue; }
    if (op.kind === 0) { state = op.v; continue; }
    const keys = op.k || [];
    let target = state;
    for (const k of keys.slice(0, -1)) target = target[k] ??= {};
    const last = keys.at(-1);
    if (op.kind === 1) target[last] = op.v;
    else if (op.kind === 2) target[last] = [...(target[last] || []), ...(Array.isArray(op.v) ? op.v : [op.v])];
  }
  return state;
}
const responseText = parts => (parts || []).map(p => (p.kind === undefined || p.kind === 'markdownContent' ? (typeof p.value === 'string' ? p.value : p.content?.value || '') : '')).join('').trim();

let copilotCache = { key:'', list:[] };
function copilotFiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(codeStorage); } catch { return out; }
  for (const dir of dirs) {
    const chats = path.join(codeStorage, dir, 'chatSessions');
    let names = [];
    try { names = fs.readdirSync(chats); } catch { continue; }
    for (const name of names) if (/\.jsonl?$/.test(name)) out.push({ file:path.join(chats, name), dir:path.join(codeStorage, dir), at:mtime(path.join(chats, name)) });
  }
  return out.filter(f => f.at > Date.now() - RECENT).sort((a, b) => b.at - a.at);
}
function copilotList() {
  const files = copilotFiles();
  const key = files.map(f => f.file + f.at).join('|');
  if (key === copilotCache.key) return copilotCache.list;
  const list = [];
  for (const f of files) {
    let chat;
    try { chat = readCopilot(f.file); } catch { continue; }
    const requests = chat.requests || [];
    if (!requests.length) continue;
    const last = requests.at(-1);
    let folder = '';
    try { folder = decodeURIComponent(new URL(JSON.parse(fs.readFileSync(path.join(f.dir, 'workspace.json'), 'utf8')).folder).pathname); } catch {}
    const pending = !last.modelState?.completedAt && !last.result && Date.now() - f.at < 3 * 60000;
    list.push({
      source:'ide', app:'vscode', harness:'copilot', id:path.basename(f.file).replace(/\.jsonl?$/, ''), file:f.file,
      title:chat.customTitle || String(requests[0].message?.text || 'Copilot chat').split('\n')[0].slice(0, 80),
      project:folder ? path.basename(folder) : 'VS Code', cwd:folder, status:pending ? 'busy' : 'done', updatedAt:f.at,
    });
    if (list.length >= PER_APP) break;
  }
  copilotCache = { key, list };
  return list;
}

export async function list() {
  const cursor = (await cursorList().catch(() => [])).filter(c => c.status === 'busy' || c.updatedAt > Date.now() - RECENT).slice(0, PER_APP);
  return [...cursor, ...copilotList()].map(({ file, ...c }) => c);
}

export async function thread(app, id) {
  if (app === 'cursor') {
    const session = (await cursorList()).find(c => c.id === id) || { source:'ide', app, harness:'cursor', id, title:'Cursor chat', project:'Cursor', status:'done' };
    return { session, messages:await cursorThread(id), readOnly:true, note:'Reply to this chat in Cursor on your Mac.' };
  }
  if (app === 'vscode') {
    const found = copilotList().find(c => c.id === id);
    if (!found) throw Object.assign(new Error('That VS Code chat is gone.'), { status:404 });
    const chat = readCopilot(found.file);
    const messages = [];
    for (const r of chat.requests || []) {
      if (r.message?.text) messages.push({ role:'user', text:r.message.text, time:r.timestamp });
      const text = responseText(r.response);
      if (text) messages.push({ role:'assistant', text, time:r.modelState?.completedAt || r.timestamp });
    }
    const { file, ...session } = found;
    return { session, messages, readOnly:true, note:'Reply to this chat in VS Code on your Mac.' };
  }
  throw Object.assign(new Error('Unknown app.'), { status:400 });
}

// Bring the chat's app to the front on the Mac, in its project folder when known.
export async function open(app, id) {
  const name = { cursor:'Cursor', vscode:'Visual Studio Code' }[app];
  if (!name) throw Object.assign(new Error('Unknown app.'), { status:400 });
  const cwd = app === 'vscode' ? copilotList().find(c => c.id === id)?.cwd : '';
  await run('/usr/bin/open', ['-a', name, ...(cwd ? [cwd] : [])]);
}
