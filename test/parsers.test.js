import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemory, parseDisk, parseBattery, parseProcesses, parseLsof, parseLaunchctlList } from '../server/system.js';
import { parseBrew, parseNpm, parseSoftwareUpdate } from '../server/updates.js';
import { parseClaude, parseCodex } from '../server/agents.js';
import { parseRows } from '../server/privacy.js';

test('memory counts active, wired and compressed pages', () => {
  const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active:  100.\nPages wired down:  50.\nPages occupied by compressor:  10.\n';
  assert.deepEqual(parseMemory(vm, 1e12), { total:1e12, used:160 * 16384 });
});

test('disk and battery', () => {
  assert.deepEqual(parseDisk('Filesystem 1024-blocks Used Available Capacity\n/dev/disk3s1s1 1000 400 600 40% /'), { total:1024000, used:409600, free:614400 });
  assert.deepEqual(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t87%; charging; 1:02 remaining"), { percent:87, state:'charging', source:'AC' });
});

test('processes read app bundle names', () => {
  const [p] = parseProcesses('  412     1 me    3.5  1.2  20480   01:02:03 /Applications/Slack.app/Contents/MacOS/Slack --flag');
  assert.equal(p.name, 'Slack');
  assert.equal(p.rss, 20480 * 1024);
  assert.equal(p.cpu, 3.5);
});

test('lsof listeners mark exposed addresses', () => {
  const rows = parseLsof('p10\ncnode\nLme\nf20\nPTCP\nn127.0.0.1:4480\nf21\nPTCP\nn*:3000\np11\ncrapportd\nLme\nf5\nPUDP\nn*:*\n');
  assert.deepEqual(rows.map(r => [r.port, r.exposed, r.command]), [[3000, true, 'node'], [4480, false, 'node']]);
});

test('launchctl list', () => {
  const map = parseLaunchctlList('PID\tStatus\tLabel\n123\t0\tcom.a\n-\t78\tcom.b\n');
  assert.deepEqual(map.get('com.a'), { pid:123, status:0 });
  assert.deepEqual(map.get('com.b'), { pid:null, status:78 });
});

test('update parsers', () => {
  const brew = parseBrew(JSON.stringify({ formulae:[{ name:'git', installed_versions:['2.40'], current_version:'2.41', pinned:false }], casks:[{ name:'firefox', installed_versions:['120'], current_version:'121' }] }));
  assert.deepEqual(brew.map(i => i.id), ['formula:git', 'cask:firefox']);
  assert.deepEqual(parseNpm('{"npm":{"current":"10.0.0","latest":"10.1.0"},"same":{"current":"1","latest":"1"}}').map(i => i.name), ['npm']);
  const su = parseSoftwareUpdate('Software Update found:\n* Label: macOS 26.1-25B1\n\tTitle: macOS 26.1, Version: 26.1, Size: 1G, Recommended: YES, Action: restart,\n');
  assert.equal(su[0].name, 'macOS 26.1');
  assert.equal(su[0].restart, true);
});

test('claude transcript keeps text and tool calls, drops meta', () => {
  const text = [
    { type:'user', message:{ content:'fix the bug' }, timestamp:'t1' },
    { type:'user', isMeta:true, message:{ content:'ignored' } },
    { type:'assistant', message:{ content:[{ type:'text', text:'On it' }, { type:'tool_use', name:'Bash', input:{ command:'npm test' } }] } },
    { type:'user', message:{ content:[{ type:'tool_result', content:'ok' }] } },
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(parseClaude(text).map(m => [m.role, m.text]), [['user', 'fix the bug'], ['assistant', 'On it'], ['tool', 'Bash: npm test']]);
});

test('codex transcript', () => {
  const text = [
    { type:'response_item', payload:{ type:'message', role:'developer', content:[{ type:'input_text', text:'sys' }] } },
    { type:'response_item', payload:{ type:'message', role:'user', content:[{ type:'input_text', text:'hello' }] } },
    { type:'response_item', payload:{ type:'function_call', name:'shell', arguments:'{"command":["ls","-la"]}' } },
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(parseCodex(text).map(m => [m.role, m.text]), [['user', 'hello'], ['tool', 'shell: ls -la']]);
});

test('tcc rows', () => {
  const [row] = parseRows('[{"service":"kTCCServiceCamera","client":"us.zoom.xos","client_type":0,"auth_value":2,"last_modified":1700000000}]', 'user');
  assert.equal(row.label, 'Camera');
  assert.equal(row.status, 'allowed');
  assert.equal(row.revocable, true);
});

test('terminal menus become choices only while the agent is asking', async () => {
  const { parseChoices } = await import('../server/terminal.js');
  const screen = ['Bash command', '  rm -rf build', 'Do you want to proceed?', '❯ 1. Yes', '  2. Yes, and don\'t ask again', '  3. No, and tell Claude what to do differently (esc)'].join('\n');
  assert.deepEqual(parseChoices(screen).map(c => c.key), ['1', '2', '3']);
  assert.equal(parseChoices(screen)[1].label, "Yes, and don't ask again");
  assert.deepEqual(parseChoices('1. a list item\n2. another'), []);
});

test('markdown escapes html', async () => {
  const { markdown } = await import('../public/markdown.js');
  assert.equal(markdown('<img src=x onerror=alert(1)> **b**'), '<p>&lt;img src=x onerror=alert(1)&gt; <b>b</b></p>');
});

test('titles drop pasted context and markup', async () => {
  const { cleanTitle } = await import('../server/agents.js');
  assert.equal(cleanTitle('<system-reminder>ignore</system-reminder> **Fix** the `login` bug'), 'Fix the login bug');
  assert.equal(cleanTitle('Context handoff (summary): lots of text'), '');
});

test('usage limits: Claude endpoint and Codex rate_limits', async () => {
  const { parseClaude, parseCodexRateLimits } = await import('../server/usage.js');
  const claude = parseClaude({ five_hour:{ utilization:78.4, resets_at:'2026-10-24T10:40:00+00:00' }, seven_day:{ utilization:77, resets_at:null }, seven_day_opus:null });
  assert.deepEqual(claude.map(w => [w.label, w.percent]), [['Session (5-hour)', 78], ['Weekly', 77]]);
  assert.equal(claude[0].resetsAt, Date.parse('2026-10-24T10:40:00Z'));
  const codex = parseCodexRateLimits({ primary:{ used_percent:12, window_minutes:10080, resets_at:1793382538 }, secondary:{ used_percent:40.6, window_minutes:300, resets_at:1793300000 } });
  assert.deepEqual(codex.map(w => [w.label, w.percent]), [['5-hour', 41], ['Weekly', 12]]);
  assert.equal(codex[1].resetsAt, 1793382538000);
  assert.deepEqual(parseCodexRateLimits(null), []);
});

test('T3 thread states: waiting beats working, queued counts as working', async () => {
  const { summarize } = await import('../server/t3.js');
  const base = { id:'t', title:'x', providerInstanceId:'claudeAgent', updatedAt:'2026-10-29T10:00:00Z' };
  assert.equal(summarize({ ...base, status:'queued', activityRunStatus:'running' }).status, 'busy');
  assert.equal(summarize({ ...base, status:'running', pendingRuntimeRequest:{ id:'r' } }).status, 'waiting');
  assert.equal(summarize({ ...base, status:'completed' }).status, 'done');
  assert.equal(summarize({ ...base, status:'failed' }).status, 'failed');
  assert.equal(summarize({ ...base, status:'idle', providerInstanceId:'codex' }).harness, 'codex');
});
