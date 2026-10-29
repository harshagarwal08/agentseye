import { spawn } from 'node:child_process';
import path from 'node:path';
import { run } from './exec.js';

// The script goes in on stdin and every value as argv, so nothing a person types is ever parsed as AppleScript.
// If Lookout itself was started from inside an agent (or a Terminal it launches inherits from one), the
// agent's session markers would leak into new sessions and, for example, turn off Claude's transcript saving.
const sessionMarker = /^(CLAUDECODE|CLAUDE_CODE_\w+|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CODEX_\w*SESSION\w*)$/;
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !sessionMarker.test(k)));
const unsetMarkers = 'unset $(env | cut -d= -f1 | grep -E \'^(CLAUDECODE|CLAUDE_CODE_[A-Z_]+|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION)$\') 2>/dev/null;';

function osascript(script, args = [], timeout = 8000) {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/osascript', ['-', ...args.map(String)], { env:cleanEnv() });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('close', code => { clearTimeout(timer); resolve({ ok:code === 0, out:out.replace(/\n$/, ''), err:err.trim() }); });
    child.stdin.end(script);
  });
}

const findTab = `on findTab(ttyName)
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is ttyName and (count of processes of t) > 0 then return t
      end repeat
    end repeat
  end tell
  return missing value
end findTab
`;

// Telling Terminal anything launches it, so check it is already running first.
async function terminalRunning() {
  return (await run('/usr/bin/pgrep', ['-x', 'Terminal'])).ok;
}

const ttyCache = new Map();
export async function ttyOf(pid) {
  const hit = ttyCache.get(pid);
  if (hit && Date.now() - hit.at < 60000) return hit.tty;
  const name = (await run('/bin/ps', ['-o', 'tty=', '-p', String(pid)])).stdout.trim();
  const tty = /^ttys\d+$/.test(name) ? `/dev/${name}` : '';
  ttyCache.set(pid, { at:Date.now(), tty });
  return tty;
}

// Whether a Terminal.app tab owns this tty; cached briefly because each check costs ~0.2 s.
const tabCache = new Map();
export async function inTerminal(tty) {
  if (!tty) return false;
  const hit = tabCache.get(tty);
  if (hit && Date.now() - hit.at < 10000) return hit.value;
  const value = (await terminalRunning()) && (await osascript(`${findTab}on run argv\nif findTab(item 1 of argv) is missing value then return "no"\nreturn "yes"\nend run`, [tty])).out === 'yes';
  tabCache.set(tty, { at:Date.now(), value });
  return value;
}

export async function readScreen(tty, lines = 60) {
  const r = await osascript(`${findTab}on run argv\nset t to findTab(item 1 of argv)\nif t is missing value then return ""\ntell application "Terminal" to return history of t\nend run`, [tty]);
  // Terminal pads the history with blank lines below the cursor; drop those before taking the tail.
  return r.out.replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trimEnd().split('\n').slice(-lines).join('\n');
}

// The agent must be the tab's foreground program, or the text would land in a shell.
export async function agentInForeground(tty, harness) {
  const r = await run('/bin/ps', ['-t', path.basename(tty), '-o', 'stat=,comm=']);
  const names = harness === 'codex' ? ['codex', 'node'] : ['claude', 'node'];
  return r.stdout.split('\n').some(line => {
    const m = line.trim().match(/^(\S+)\s+(.+)$/);
    return m && m[1].includes('+') && names.includes(path.basename(m[2]));
  });
}

const question = /Do you want to|Esc to cancel|Enter to confirm|❯\s*1\.|Would you like to|trust this folder|Press enter to confirm/i;
export const asking = screen => question.test(screen.split('\n').slice(-16).join('\n'));

// Numbered options of the menu at the bottom of the screen, if the agent is showing one.
export function parseChoices(screen) {
  if (!asking(screen)) return [];
  const tail = screen.split('\n').slice(-24);
  const choices = [];
  for (const line of tail) {
    const m = line.match(/^\s*[│|]?\s*(?:[❯›>]\s*)?(\d)[.)]\s+(.+?)\s*[│|]?\s*$/);
    if (!m) continue;
    if (choices.length && Number(m[1]) <= Number(choices.at(-1).key)) choices.length = 0;
    choices.push({ key:m[1], label:m[2] });
  }
  return choices.slice(0, 9);
}

async function doScript(tty, text) {
  const r = await osascript(`${findTab}on run argv\nset t to findTab(item 1 of argv)\nif t is missing value then return "missing"\ntell application "Terminal" to do script (item 2 of argv) in t\nreturn "ok"\nend run`, [tty, text]);
  if (r.out !== 'ok') throw Object.assign(new Error(r.out === 'missing' ? 'That Terminal tab is gone.' : r.err || 'Could not reach Terminal.'), { status:409 });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// do script always appends Return. Text goes in as a bracketed paste, so that Return lands inside the paste;
// the submitting Return is sent separately once the agent is confirmed to still be in front.
// If it left meanwhile, the half-typed line is cleared (Ctrl-U) instead of being run by the shell.
export async function sendText(tty, harness, text) {
  if (!await agentInForeground(tty, harness)) throw Object.assign(new Error('The agent is not running in that tab any more.'), { status:409 });
  if (asking(await readScreen(tty, 20))) throw Object.assign(new Error('The agent is asking a question. Answer it from the Terminal tab first.'), { status:409 });
  await doScript(tty, `\x1b[200~${text.replace(/\x1b/g, '')}\x1b[201~`);
  await sleep(600);
  if (await agentInForeground(tty, harness)) await doScript(tty, '');
  else { await doScript(tty, '\x15'); throw Object.assign(new Error('The agent exited before the message was sent.'), { status:409 }); }
}

const keys = { esc:'\x1b', mode:'\x1b[Z', enter:'', 1:'1', 2:'2', 3:'3', 4:'4', 5:'5', 6:'6', 7:'7', 8:'8', 9:'9' };
export async function sendKey(tty, harness, key) {
  if (!(key in keys)) throw Object.assign(new Error('Unsupported key.'), { status:400 });
  if (!await agentInForeground(tty, harness)) throw Object.assign(new Error('The agent is not running in that tab any more.'), { status:409 });
  await doScript(tty, keys[key]);
}

export function openWindow(command) {
  return osascript('on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run', [`${unsetMarkers} ${command}`]);
}
