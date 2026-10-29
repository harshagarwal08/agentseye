import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Capture the command Lookout would type into a new Terminal window instead of opening one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lookout-launch-'));
process.env.LOOKOUT_HOME = path.join(home, '.lookout');
process.env.LOOKOUT_USER_HOME = home;
const typed = [];
mock.module('../server/terminal.js', { namedExports:{ openWindow:async cmd => { typed.push(cmd); return { ok:true }; } } });
const agents = await import('../server/agents.js');

test('new Claude session gets its id up front, plus model, name and permission flags', async () => {
  const r = await agents.start('claude', home, "fix the 'login' bug", { model:'opus', skipPermissions:true, name:'Login' });
  assert.match(r.id, /^[0-9a-f-]{36}$/);
  assert.equal(typed.at(-1), `cd '${home}' && claude --session-id ${r.id} --model 'opus' --dangerously-skip-permissions -n 'Login' 'fix the '\\''login'\\'' bug'`);
});

test('Codex start and forks use their own flags', async () => {
  await agents.start('codex', home, 'hi', { model:'gpt-6' });
  assert.equal(typed.at(-1), `cd '${home}' && codex --no-alt-screen -m 'gpt-6' 'hi'`);
  const id = '01a172b3-b231-7f11-9ec1-32f9c77d4788';
  await agents.fork('codex', id, home, 'go on');
  assert.equal(typed.at(-1), `cd '${home}' && codex fork '${id}' --no-alt-screen  'go on'`);
  const copy = await agents.fork('claude', '11111111-2222-3333-4444-555555555555', home, 'continue');
  assert.match(typed.at(-1), new RegExp(`claude --resume '11111111-2222-3333-4444-555555555555' --fork-session --session-id ${copy.id}  'continue'$`));
});

test('rejects odd model names and missing folders', async () => {
  await assert.rejects(agents.start('claude', home, '', { model:'opus; rm -rf ~' }), /model name/);
  await assert.rejects(agents.start('claude', path.join(home, 'nope'), ''), /Folder does not exist/);
});
