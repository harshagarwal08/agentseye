import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A fake home with one Cursor chat (in its SQLite store) and one VS Code Copilot chat (as an edit log).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-ides-'));
process.env.AGENTSEYE_USER_HOME = home;
process.env.AGENTSEYE_HOME = path.join(home, '.agentseye');
const support = path.join(home, 'Library', 'Application Support');
const now = Date.now();

const cursorDir = path.join(support, 'Cursor', 'User', 'globalStorage');
fs.mkdirSync(cursorDir, { recursive:true });
const rows = [
  [`composerData:c1`, { name:'Fix the navbar', status:'generating', createdAt:now - 5000, lastUpdatedAt:now, fullConversationHeadersOnly:[{ bubbleId:'b1' }, { bubbleId:'b2' }, { bubbleId:'b3' }] }],
  ['bubbleId:c1:b1', { type:1, text:'fix the navbar', createdAt:'2026-10-29T10:00:00Z' }],
  ['bubbleId:c1:b2', { type:2, text:'Looking at it.', createdAt:'2026-10-29T10:00:01Z' }],
  ['bubbleId:c1:b3', { type:2, text:'Done.', createdAt:'2026-10-29T10:00:02Z' }],
];
const q = s => `'${s.replace(/'/g, "''")}'`;
execFileSync('/usr/bin/sqlite3', [path.join(cursorDir, 'state.vscdb'), `create table cursorDiskKV (key text unique on conflict replace, value blob); ${rows.map(([k, v]) => `insert into cursorDiskKV values (${q(k)}, ${q(JSON.stringify(v))});`).join(' ')}`]);

const ws = path.join(support, 'Code', 'User', 'workspaceStorage', 'abc');
fs.mkdirSync(path.join(ws, 'chatSessions'), { recursive:true });
fs.writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ folder:'file:///Users/me/shop' }));
fs.writeFileSync(path.join(ws, 'chatSessions', 's1.jsonl'), [
  { kind:0, v:{ sessionId:'s1', requests:[] } },
  { kind:1, k:['customTitle'], v:'Add checkout' },
  { kind:2, k:['requests'], v:[{ message:{ text:'add a checkout page' }, timestamp:now, response:[{ kind:'toolInvocationSerialized' }, { value:'Added ' }, { kind:'markdownContent', content:{ value:'the page.' } }], modelState:{ value:1, completedAt:now } }] },
].map(l => JSON.stringify(l)).join('\n'));

const ides = await import('../server/ides.js');

test('Cursor and VS Code chats are listed with their state', async () => {
  const list = await ides.list();
  const cursor = list.find(c => c.app === 'cursor');
  const code = list.find(c => c.app === 'vscode');
  assert.equal(cursor.title, 'Fix the navbar');
  assert.equal(cursor.status, 'busy');
  assert.equal(code.title, 'Add checkout');
  assert.equal(code.project, 'shop');
  assert.equal(code.status, 'done');
});

test('chat transcripts read back in order, with split replies joined', async () => {
  const c = await ides.thread('cursor', 'c1');
  assert.deepEqual(c.messages.map(m => [m.role, m.text]), [['user', 'fix the navbar'], ['assistant', 'Looking at it.\n\nDone.']]);
  assert.equal(c.readOnly, true);
  const v = await ides.thread('vscode', 's1');
  assert.deepEqual(v.messages.map(m => [m.role, m.text]), [['user', 'add a checkout page'], ['assistant', 'Added the page.']]);
});

test.after(() => fs.rmSync(home, { recursive:true, force:true }));
