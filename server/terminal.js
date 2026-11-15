import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';

// Seeing and typing into the terminal an agent runs in. Three ways in, tried in this order for each tty:
//   tmux       works in any terminal app (Ghostty, Warp, kitty, the VS Code / Cursor terminal…) when the agent runs in tmux
//   iTerm2     through its AppleScript dictionary
//   Terminal   through Terminal.app's AppleScript dictionary
// Every value goes in as argv (AppleScript) or as a separate argument / stdin (tmux), so nothing typed on the
// phone is ever parsed as a script.

// If AgentsEye itself was started from inside an agent (or a Terminal it launches inherits from one), the
// agent's session markers would leak into new sessions and, for example, turn off Claude's transcript saving.
const sessionMarker = /^(CLAUDECODE|CLAUDE_CODE_\w+|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CODEX_\w*SESSION\w*)$/;
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !sessionMarker.test(k)));
const unsetMarkers = 'unset $(env | cut -d= -f1 | grep -E \'^(CLAUDECODE|CLAUDE_CODE_[A-Z_]+|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION)$\') 2>/dev/null;';
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function osascript(script, args = [], timeout = 8000) {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/osascript', ['-', ...args.map(String)], { env:cleanEnv() });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', e => { err += e.message; });
    child.on('close', code => { clearTimeout(timer); resolve({ ok:code === 0, out:out.replace(/\n$/, ''), err:err.trim() }); });
    child.stdin.end(script);
  });
}

// ---------- Terminal.app ----------
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
const appleTerminal = {
  name:'Terminal',
  // Telling an app anything launches it, so check it is already running first.
  running:async () => (await run('/usr/bin/pgrep', ['-x', 'Terminal'])).ok,
  owns:async tty => (await osascript(`${findTab}on run argv\nif findTab(item 1 of argv) is missing value then return "no"\nreturn "yes"\nend run`, [tty])).out === 'yes',
  read:async tty => (await osascript(`${findTab}on run argv\nset t to findTab(item 1 of argv)\nif t is missing value then return ""\ntell application "Terminal" to return history of t\nend run`, [tty])).out,
  // do script always appends Return.
  async write(tty, text) {
    const r = await osascript(`${findTab}on run argv\nset t to findTab(item 1 of argv)\nif t is missing value then return "missing"\ntell application "Terminal" to do script (item 2 of argv) in t\nreturn "ok"\nend run`, [tty, text]);
    if (r.out !== 'ok') throw fail(r.out === 'missing' ? 'That Terminal tab is gone.' : r.err || 'Could not reach Terminal.');
  },
  async paste(tty, text) { await this.write(tty, `\x1b[200~${text}\x1b[201~`); },
  submit(tty) { return this.write(tty, ''); },
  clearLine(tty) { return this.write(tty, '\x15'); },
  // Every write ends with Return, so only keys where a Return afterwards is harmless (or wanted) are offered.
  keys:{ esc:'\x1b', mode:'\x1b[Z', enter:'', y:'y', n:'n', 1:'1', 2:'2', 3:'3', 4:'4', 5:'5', 6:'6', 7:'7', 8:'8', 9:'9' },
  key(tty, key) { return this.write(tty, this.keys[key]); },
};

// ---------- iTerm2 ----------
const findSession = `on findSession(ttyName)
  tell application id "com.googlecode.iterm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is ttyName then return s
        end repeat
      end repeat
    end repeat
  end tell
  return missing value
end findSession
`;
const itermWrite = (newline) => `${findSession}on run argv\nset s to findSession(item 1 of argv)\nif s is missing value then return "missing"\ntell application id "com.googlecode.iterm2" to tell s to write text (item 2 of argv) newline ${newline ? 'YES' : 'NO'}\nreturn "ok"\nend run`;
const iterm = {
  name:'iTerm',
  running:async () => (await run('/usr/bin/pgrep', ['-x', 'iTerm2'])).ok,
  owns:async tty => (await osascript(`${findSession}on run argv\nif findSession(item 1 of argv) is missing value then return "no"\nreturn "yes"\nend run`, [tty])).out === 'yes',
  read:async tty => (await osascript(`${findSession}on run argv\nset s to findSession(item 1 of argv)\nif s is missing value then return ""\ntell application id "com.googlecode.iterm2" to return contents of s\nend run`, [tty])).out,
  async write(tty, text, newline = false) {
    const r = await osascript(itermWrite(newline), [tty, text]);
    if (r.out !== 'ok') throw fail(r.out === 'missing' ? 'That iTerm session is gone.' : r.err || 'Could not reach iTerm.');
  },
  paste(tty, text) { return this.write(tty, `\x1b[200~${text}\x1b[201~`); },
  submit(tty) { return this.write(tty, '\r'); },
  clearLine(tty) { return this.write(tty, '\x15'); },
  keys:{ esc:'\x1b', mode:'\x1b[Z', enter:'\r', up:'\x1b[A', down:'\x1b[B', tab:'\t', ctrlc:'\x03', y:'y', n:'n', 1:'1', 2:'2', 3:'3', 4:'4', 5:'5', 6:'6', 7:'7', 8:'8', 9:'9' },
  key(tty, key) { return this.write(tty, this.keys[key]); },
};

// ---------- tmux ----------
let tmuxPath = null;
export async function tmuxBin() {
  if (tmuxPath !== null) return tmuxPath;
  for (const c of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) if (fs.existsSync(c)) return (tmuxPath = c);
  const w = await run('/usr/bin/which', ['tmux']);
  return (tmuxPath = w.ok ? w.stdout.trim() : '');
}
// tty → pane id ("%3") for every pane on the default tmux server.
export function parsePanes(text) {
  const panes = new Map();
  for (const line of String(text).split('\n')) {
    const [tty, id] = line.trim().split(/\s+/);
    if (/^\/dev\/tty\w+$/.test(tty || '') && /^%\d+$/.test(id || '')) panes.set(tty, id);
  }
  return panes;
}
let paneCache = { at:0, panes:new Map() };
async function panes() {
  if (Date.now() - paneCache.at < 3000) return paneCache.panes;
  const bin = await tmuxBin();
  const r = bin ? await run(bin, ['list-panes', '-a', '-F', '#{pane_tty} #{pane_id}'], { timeout:4000 }) : { ok:false };
  paneCache = { at:Date.now(), panes:r.ok ? parsePanes(r.stdout) : new Map() };
  return paneCache.panes;
}
async function tmuxRun(args, input) {
  const bin = await tmuxBin();
  return new Promise(resolve => {
    const child = spawn(bin, args, { env:cleanEnv() });
    let out = '';
    let err = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', e => { err += e.message; });
    child.on('close', code => resolve({ ok:code === 0, out, err:err.trim() }));
    child.stdin.end(input ?? '');
  });
}
const pane = async tty => { const id = (await panes()).get(tty); if (!id) throw fail('That tmux pane is gone.'); return id; };
const tmuxKeys = { esc:'Escape', mode:'BTab', enter:'Enter', up:'Up', down:'Down', tab:'Tab', ctrlc:'C-c', y:'y', n:'n', 1:'1', 2:'2', 3:'3', 4:'4', 5:'5', 6:'6', 7:'7', 8:'8', 9:'9' };
const tmux = {
  name:'tmux',
  running:async () => Boolean(await tmuxBin()) && (await panes()).size > 0,
  owns:async tty => (await panes()).has(tty),
  read:async tty => (await tmuxRun(['capture-pane', '-p', '-J', '-S', '-200', '-t', await pane(tty)])).out,
  // paste-buffer -p wraps the text in bracketed-paste markers only if the program asked for them, like a real paste.
  async paste(tty, text) {
    const id = await pane(tty);
    const loaded = await tmuxRun(['load-buffer', '-b', 'agentseye', '-'], text);
    if (!loaded.ok) throw fail(loaded.err || 'Could not reach tmux.');
    const r = await tmuxRun(['paste-buffer', '-p', '-d', '-b', 'agentseye', '-t', id]);
    if (!r.ok) throw fail(r.err || 'Could not reach tmux.');
  },
  async submit(tty) { await tmuxRun(['send-keys', '-t', await pane(tty), 'Enter']); },
  async clearLine(tty) { await tmuxRun(['send-keys', '-t', await pane(tty), 'C-u']); },
  keys:tmuxKeys,
  async key(tty, key) { await tmuxRun(['send-keys', '-t', await pane(tty), tmuxKeys[key]]); },
};

const backends = { tmux, iterm, terminal:appleTerminal };

const ttyCache = new Map();
export async function ttyOf(pid) {
  const hit = ttyCache.get(pid);
  if (hit && Date.now() - hit.at < 60000) return hit.tty;
  const name = (await run('/bin/ps', ['-o', 'tty=', '-p', String(pid)])).stdout.trim();
  const tty = /^tty\w+$/.test(name) && name !== 'tty' ? `/dev/${name}` : '';
  ttyCache.set(pid, { at:Date.now(), tty });
  return tty;
}

// Which backend owns this tty: 'tmux', 'iterm', 'terminal' or ''. Cached briefly because each check costs ~0.2 s.
const hostCache = new Map();
export async function hostOf(tty) {
  if (!tty) return '';
  const hit = hostCache.get(tty);
  if (hit && Date.now() - hit.at < 10000) return hit.value;
  let value = '';
  for (const [key, b] of Object.entries(backends)) {
    try { if (await b.running() && await b.owns(tty)) { value = key; break; } } catch {}
  }
  hostCache.set(tty, { at:Date.now(), value });
  return value;
}
export const inTerminal = async tty => Boolean(await hostOf(tty));
export const hostName = key => backends[key]?.name || '';
// The keys the phone may offer for a tty, depending on what its terminal can send.
export const keysFor = key => Object.keys(backends[key]?.keys || {});
const backend = async tty => {
  const key = await hostOf(tty);
  if (!key) throw fail('That terminal is gone.');
  return backends[key];
};

export async function readScreen(tty, lines = 60) {
  const b = await backend(tty);
  const out = await b.read(tty).catch(() => '');
  // Terminals pad the screen with blank lines below the cursor; drop those before taking the tail.
  return String(out).replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trimEnd().split('\n').slice(-lines).join('\n');
}

// The agent must be the tab's foreground program, or the text would land in a shell. With a pid, that exact
// process must be in the foreground group; otherwise any foreground process with one of the agent's names.
const FOREGROUND_NAMES = { codex:['codex', 'node'], claude:['claude', 'node'] };
export function foregroundIn(psOutput, { pid, names = [] } = {}) {
  return String(psOutput).split('\n').some(line => {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!m || !m[2].includes('+')) return false;
    return pid ? Number(m[1]) === pid : names.includes(path.basename(m[3]));
  });
}
export async function agentInForeground(tty, harness, pid) {
  const r = await run('/bin/ps', ['-t', path.basename(tty), '-o', 'pid=,stat=,comm=']);
  return foregroundIn(r.stdout, { pid:harness === 'cli' ? pid : undefined, names:FOREGROUND_NAMES[harness] || [] });
}

const question = /Do you want to|Esc to cancel|Enter to confirm|❯\s*1\.|Would you like to|trust this folder|Press enter to confirm|Allow execution|Apply this change|Waiting for user confirmation|\(y\/n\)|\[y\/N\]|\[Y\/n\]|Allow once|Yes, allow/i;
// Most agent TUIs show a timer or an interrupt hint while they work: "(esc to cancel, 12s)", "esc interrupt"…
const busyHint = /\((?:esc|ctrl\+c) to (?:cancel|interrupt)[^)]*\d+s\)|esc to interrupt|esc interrupt|ctrl\+c to (?:interrupt|stop)|press esc to stop/i;
export const working = screen => busyHint.test(String(screen).split('\n').slice(-12).join('\n'));
export const asking = screen => !working(screen) && question.test(screen.split('\n').slice(-16).join('\n'));
// What a terminal agent is doing, judged from its screen: 'busy', 'waiting' (asking you something) or 'open'.
export const screenStatus = screen => (working(screen) ? 'busy' : asking(screen) ? 'waiting' : 'open');

// Numbered options of the menu at the bottom of the screen, if the agent is showing one.
export function parseChoices(screen) {
  if (!asking(screen)) return [];
  const tail = screen.split('\n').slice(-24);
  const choices = [];
  for (const line of tail) {
    const m = line.match(/^\s*[│|]?\s*(?:[❯›>●]\s*)?(\d)[.)]\s+(.+?)\s*[│|]?\s*$/);
    if (!m) continue;
    if (choices.length && Number(m[1]) <= Number(choices.at(-1).key)) choices.length = 0;
    choices.push({ key:m[1], label:m[2] });
  }
  return choices.slice(0, 9);
}

// Text goes in as a (bracketed) paste so newlines inside it don't submit early; the submitting Return is sent
// separately once the agent is confirmed to still be in front. If it left meanwhile, the half-typed line is
// cleared (Ctrl-U) instead of being run by the shell.
export async function sendText(tty, harness, text, pid) {
  if (!await agentInForeground(tty, harness, pid)) throw fail('The agent is not running in that tab any more.');
  if (asking(await readScreen(tty, 20))) throw fail('The agent is asking a question. Answer it from the Terminal tab first.');
  const b = await backend(tty);
  await b.paste(tty, text.replace(/\x1b/g, ''));
  await sleep(600);
  if (await agentInForeground(tty, harness, pid)) await b.submit(tty);
  else { await b.clearLine(tty); throw fail('The agent exited before the message was sent.'); }
}

export async function sendKey(tty, harness, key, pid) {
  const b = await backend(tty);
  if (!(key in b.keys)) throw fail(`${b.name} can't send that key from here.`, 400);
  if (!await agentInForeground(tty, harness, pid)) throw fail('The agent is not running in that tab any more.');
  await b.key(tty, key);
}

// A new window's shell can take seconds to load (nvm, plugins); text typed before it is ready gets mangled.
// So: open an empty window, wait until only the shell is in the foreground for a moment, then type the command.
// The leading space keeps it out of shell history and makes a stray first keystroke harmless.
const shells = new Set(['zsh', '-zsh', 'bash', '-bash', 'fish', '-fish', 'sh', 'login']);
export async function shellReady(tty) {
  const r = await run('/bin/ps', ['-t', path.basename(tty), '-o', 'stat=,comm=']);
  const fg = r.stdout.split('\n').map(l => l.trim().match(/^(\S+)\s+(.+)$/)).filter(m => m && m[1].includes('+')).map(m => path.basename(m[2]));
  return fg.length > 0 && fg.every(c => shells.has(c));
}

export async function openWindow(command, { readyTimeout = 20000 } = {}) {
  const r = await osascript('tell application "Terminal"\nactivate\nset t to do script ""\nreturn tty of t\nend tell');
  const tty = r.out.trim();
  if (!r.ok || !/^\/dev\/ttys\d+$/.test(tty)) return { ok:false, err:r.err || 'Could not open a Terminal window.' };
  let calm = 0;
  for (const until = Date.now() + readyTimeout; Date.now() < until && calm < 3;) {
    await sleep(250);
    calm = (await shellReady(tty)) ? calm + 1 : 0;
  }
  await appleTerminal.write(tty, ` ${unsetMarkers} ${command}`);
  return { ok:true, tty };
}
