// OpenCode (opencode.ai) keeps every session in one SQLite file: ~/.local/share/opencode/opencode.db
// (or $XDG_DATA_HOME/opencode). Tables: session, message, part; message and part rows carry their details as JSON
// in a `data` column. Read only, and defensively: columns are checked first so a schema change degrades to
// "no OpenCode chats" instead of an error.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './paths.js';
import { sqliteJson, sqlQuote } from './sqlite.js';

export const dbPath = () => path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'opencode', process.env.OPENCODE_DB || 'opencode.db');
const ID = /^[\w-]{6,80}$/;
const parse = v => { if (v && typeof v === 'object') return v; try { return JSON.parse(v || '{}'); } catch { return {}; } };
const num = v => (typeof v === 'number' ? v : Number(v) || Date.parse(v) || 0);

const colCache = new Map();
async function columns(table) {
  const db = dbPath();
  const key = `${db}:${table}`;
  if (!colCache.has(key)) colCache.set(key, new Set((await sqliteJson(db, `pragma table_info(${table})`)).map(r => r.name)));
  return colCache.get(key);
}

export function toSession(row) {
  const updated = num(row.time_updated ?? row.updated_at ?? row.time_created);
  return { source:'ide', app:'opencode', harness:'opencode', id:String(row.id), title:String(row.title || 'OpenCode chat').split('\n')[0].slice(0, 90),
    cwd:row.directory || '', project:row.directory ? path.basename(row.directory) : 'OpenCode', status:'done', updatedAt:updated };
}

let cache = { at:0, checked:0, list:[] };
export async function list({ limit = 40 } = {}) {
  const db = dbPath();
  let at = 0;
  try { at = Math.max(fs.statSync(db).mtimeMs, fs.existsSync(`${db}-wal`) ? fs.statSync(`${db}-wal`).mtimeMs : 0); } catch { return []; }
  if ((at === cache.at && !cache.list.some(c => c.status === 'busy')) || Date.now() - cache.checked < 5000) return cache.list;
  cache.checked = Date.now();
  const cols = await columns('session');
  if (!cols.has('id')) return (cache = { at, checked:Date.now(), list:[] }).list;
  const where = [cols.has('parent_id') ? 'parent_id is null' : '', cols.has('time_archived') ? 'time_archived is null' : ''].filter(Boolean).join(' and ');
  const order = cols.has('time_updated') ? 'time_updated' : 'rowid';
  const rows = await sqliteJson(db, `select * from session ${where ? `where ${where}` : ''} order by ${order} desc limit ${Number(limit) || 40}`);
  const sessions = rows.map(toSession);
  // Working = the newest assistant message hasn't finished, and something was written in the last few minutes.
  for (const s of sessions.filter(x => Date.now() - x.updatedAt < 5 * 60000)) {
    const [last] = await sqliteJson(db, `select data from message where session_id = ${sqlQuote(s.id)} order by time_created desc limit 1`);
    const info = parse(last?.data);
    if (info.role === 'assistant' && !info.time?.completed) s.status = 'busy';
  }
  cache = { at, checked:Date.now(), list:sessions };
  return sessions;
}

function toolLine(p) {
  const input = p.state?.input || {};
  const value = input.command || input.filePath || input.path || input.pattern || input.url || input.description || '';
  return `${p.tool || 'tool'}${value ? `: ${String(value).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`;
}

// Turns message + part rows into the chat format used everywhere else: { role, text, time }.
export function toMessages(messages, parts) {
  const byMessage = new Map();
  for (const p of parts) {
    const data = parse(p.data);
    const list = byMessage.get(p.message_id) || [];
    list.push(data);
    byMessage.set(p.message_id, list);
  }
  const out = [];
  for (const m of messages) {
    const info = parse(m.data);
    const role = info.role === 'user' ? 'user' : 'assistant';
    const time = info.time?.created || m.time_created;
    for (const p of byMessage.get(m.id) || []) {
      if (p.type === 'text' && p.text && !p.synthetic) out.push({ role, text:String(p.text).trim(), time });
      else if (p.type === 'tool') out.push({ role:'tool', text:toolLine(p), time });
    }
  }
  return out.filter(m => m.text);
}

export async function messages(id, max = 200) {
  if (!ID.test(String(id))) return [];
  const db = dbPath();
  const rows = await sqliteJson(db, `select * from message where session_id = ${sqlQuote(id)} order by time_created`);
  if (!rows.length) return [];
  const parts = await sqliteJson(db, `select message_id, data from part where message_id in (select id from message where session_id = ${sqlQuote(id)}) order by id`);
  return toMessages(rows, parts).slice(-max);
}

// The newest session in a folder: what a running `opencode` in that folder is most likely showing.
export async function latestIn(cwd, since = 0) {
  return (await list()).find(s => s.cwd === cwd && s.updatedAt >= since - 60000) || null;
}

export async function thread(id) {
  const session = (await list()).find(s => s.id === id);
  if (!session) throw Object.assign(new Error('That OpenCode chat is gone.'), { status:404 });
  return { session, messages:await messages(id), readOnly:true, note:'Reply to this chat from OpenCode on your Mac, or open it in a terminal AgentsEye can reach.' };
}
