import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentseye-any-'));
process.env.AGENTSEYE_HOME = path.join(home, '.agentseye');
process.env.AGENTSEYE_USER_HOME = home;
process.env.XDG_DATA_HOME = path.join(home, 'xdg');

const cli = await import('../server/cli-agents.js');
const terminal = await import('../server/terminal.js');
const opencode = await import('../server/opencode.js');
const own = await import('../server/relay-deploy.js');

test('terminal agents are recognised by the program they run, not by what they mention', () => {
  assert.equal(cli.matchKind('node /opt/homebrew/bin/gemini'), 'gemini');
  assert.equal(cli.matchKind('node --max-old-space-size=8192 /opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js'), 'gemini');
  assert.equal(cli.matchKind('/Users/me/.opencode/bin/opencode'), 'opencode');
  assert.equal(cli.matchKind('/Library/Frameworks/Python.framework/Versions/3.12/bin/python3 /Users/me/.local/bin/aider --model x'), 'aider');
  assert.equal(cli.matchKind('node /Users/me/.local/share/cursor-agent/versions/2026.11.01/index.js'), 'cursor-cli');
  assert.equal(cli.matchKind('goose session'), 'goose');
  assert.equal(cli.matchKind('npm i -g @google/gemini-cli'), null);
  assert.equal(cli.matchKind('vim gemini'), null);
  assert.equal(cli.matchKind('claude -p "ask gemini about opencode"'), null);
  assert.equal(cli.matchKind('/Users/me/.local/share/opencode/bin/typescript-language-server --stdio'), null);
});

test('one agent per terminal: a relaunched child of the same CLI is not listed twice; daemons are skipped', () => {
  const procs = cli.parsePs([
    '100 1 ttys004 -zsh',
    '101 100 ttys004 node /opt/homebrew/bin/gemini',
    '102 101 ttys004 node --max-old-space-size=8192 /opt/homebrew/bin/gemini',
    '200 1 ?? node /opt/homebrew/bin/gemini',
    '300 1 ttys007 /Users/me/.opencode/bin/opencode',
  ].join('\n'));
  assert.deepEqual(cli.detect(procs), [{ kind:'gemini', pid:101, tty:'/dev/ttys004' }, { kind:'opencode', pid:300, tty:'/dev/ttys007' }]);
});

test('start commands pass the prompt with each CLI\'s own flag, quoted', () => {
  assert.equal(cli.command('gemini', "fix the 'login' bug"), "gemini -i 'fix the '\\''login'\\'' bug'");
  assert.equal(cli.command('opencode', 'hi'), "opencode --prompt 'hi'");
  assert.equal(cli.command('cursor-cli', '-v please'), "cursor-agent -- '-v please'");
  assert.equal(cli.command('aider', 'ignored here'), 'aider');
  assert.equal(cli.needsTypedPrompt('aider'), true);
  assert.equal(cli.command('goose'), 'goose session');
  assert.throws(() => cli.command('rm -rf'), /Unknown agent/);
});

test('tmux panes map ttys to pane ids; foreground checks use the exact pid for terminal agents', () => {
  const panes = terminal.parsePanes('/dev/ttys010 %3\n/dev/ttys011 %12\ngarbage\n');
  assert.equal(panes.get('/dev/ttys010'), '%3');
  assert.equal(panes.get('/dev/ttys011'), '%12');
  assert.equal(panes.size, 2);
  const ps = '  100 Ss   -zsh\n  101 S+   node\n  102 S+   node\n';
  assert.equal(terminal.foregroundIn(ps, { pid:101 }), true);
  assert.equal(terminal.foregroundIn(ps, { pid:100 }), false);
  assert.equal(terminal.foregroundIn(ps, { names:['claude', 'node'] }), true);
  assert.equal(terminal.foregroundIn('  100 S+   -zsh\n', { names:['claude', 'node'] }), false);
});

test('screen status: working timers beat "esc to cancel" prompts; questions and y/n prompts need you', () => {
  assert.equal(terminal.screenStatus('⠏ Thinking about it (esc to cancel, 12s)\n> '), 'busy');
  assert.equal(terminal.screenStatus('Allow execution of: rm -rf build?\n● 1. Yes, allow once\n  2. No'), 'waiting');
  assert.equal(terminal.screenStatus('Apply these edits? (y/n)'), 'waiting');
  assert.equal(terminal.screenStatus('> type your message'), 'open');
  assert.deepEqual(terminal.parseChoices('Allow execution of: ls?\n● 1. Yes, allow once\n  2. Yes, allow always\n  3. No'), [
    { key:'1', label:'Yes, allow once' }, { key:'2', label:'Yes, allow always' }, { key:'3', label:'No' },
  ]);
});

test('OpenCode chats are read from its SQLite database', async () => {
  const dir = path.join(home, 'xdg', 'opencode');
  fs.mkdirSync(dir, { recursive:true });
  const now = Date.now();
  const sql = `
    create table session (id text primary key, project_id text, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer);
    create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
    create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
    insert into session values ('ses_abc123', 'p1', null, '/Users/me/app', 'Fix the login page', ${now - 1000}, ${now}, null);
    insert into session values ('ses_child1', 'p1', 'ses_abc123', '/Users/me/app', 'subagent', ${now}, ${now}, null);
    insert into message values ('msg_1', 'ses_abc123', ${now - 900}, ${now - 900}, '{"role":"user","time":{"created":${now - 900}}}');
    insert into message values ('msg_2', 'ses_abc123', ${now - 800}, ${now - 700}, '{"role":"assistant","time":{"created":${now - 800}}}');
    insert into part values ('prt_1', 'msg_1', 'ses_abc123', 0, 0, '{"type":"text","text":"login is broken"}');
    insert into part values ('prt_2', 'msg_2', 'ses_abc123', 0, 0, '{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"npm test"}}}');
    insert into part values ('prt_3', 'msg_2', 'ses_abc123', 0, 0, '{"type":"text","text":"Fixed it."}');
    insert into part values ('prt_4', 'msg_2', 'ses_abc123', 0, 0, '{"type":"reasoning","text":"hmm"}');`;
  execFileSync('/usr/bin/sqlite3', [path.join(dir, 'opencode.db'), sql]);
  const list = await opencode.list();
  assert.equal(list.length, 1, 'subagent sessions are not listed');
  assert.equal(list[0].title, 'Fix the login page');
  assert.equal(list[0].cwd, '/Users/me/app');
  assert.equal(list[0].status, 'busy', 'the newest assistant message has not finished');
  assert.deepEqual((await opencode.messages('ses_abc123')).map(m => [m.role, m.text]), [['user', 'login is broken'], ['tool', 'bash: npm test'], ['assistant', 'Fixed it.']]);
  assert.equal((await opencode.latestIn('/Users/me/app')).id, 'ses_abc123');
  assert.deepEqual(await opencode.messages("x' or 1=1 --"), []);
});

test('own relay: a valid worker name, a minimal build, and the deployed address read back', () => {
  assert.equal(own.workerName('abcdefghijklmnop'), 'agentseye-abcdefghij');
  const dir = own.prepare('agentseye-test');
  for (const f of ['worker.js', 'core.js', 'mac-room.js', 'install.js', 'wrangler.toml']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.ok(fs.existsSync(path.join(dir, '..', 'public', 'app.js')));
  assert.ok(fs.existsSync(path.join(dir, '..', 'package.json')));
  const toml = fs.readFileSync(path.join(dir, 'wrangler.toml'), 'utf8');
  assert.match(toml, /^name = "agentseye-test"$/m);
  assert.doesNotMatch(toml, /MAC_DAILY_LIMIT/, 'personal relays have no daily limit');
  const out = 'Uploaded agentseye-test (3.1 sec)\nDeployed agentseye-test triggers (0.9 sec)\n  https://agentseye-test.someone.workers.dev\nCurrent Version ID: 1';
  assert.equal(own.deployedUrl(out, 'agentseye-test'), 'https://agentseye-test.someone.workers.dev');
  assert.equal(own.deployedUrl('nothing here', 'x'), '');
});
