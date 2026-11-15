// Any coding agent that runs in a terminal: Gemini CLI, OpenCode, Cursor CLI, Copilot CLI, Qwen Code, Amp, Aider,
// Goose, Crush, Droid, Kiro, Auggie, Kimi… Found by their running process; watched and driven through the terminal
// they run in (Terminal.app, iTerm2, or tmux in any terminal app — see terminal.js). Where the agent also keeps a
// readable transcript (Gemini, OpenCode), the chat is shown too.
//
// Claude Code and Codex have richer integrations of their own (agents.js) and are not listed here.
import fs from 'node:fs';
import path from 'node:path';
import { run, shellQuote } from './exec.js';
import { HOME } from './paths.js';

const word = name => new RegExp(`(?:^|[\\s/])${name.replace(/[-.]/g, '\\$&')}(?:\\s|$)`);
// kind: stable id · bin: command to start it · re: matches its process arguments · prompt: how to start with a prompt
// (omitted when the CLI has no such flag; the prompt is typed in once it is ready instead).
export const KINDS = [
  { kind:'gemini', name:'Gemini CLI', bin:'gemini', re:[word('gemini'), /@google\/gemini-cli\b/], prompt:p => `-i ${shellQuote(p)}` },
  { kind:'opencode', name:'OpenCode', bin:'opencode', re:[word('opencode'), /\bopencode-ai\b/], prompt:p => `--prompt ${shellQuote(p)}` },
  { kind:'cursor-cli', name:'Cursor CLI', bin:'cursor-agent', re:[word('cursor-agent'), /\/cursor-agent\/versions\//], prompt:p => shellQuote(p) },
  { kind:'copilot-cli', name:'Copilot CLI', bin:'copilot', re:[word('copilot'), /@github\/copilot\b/], prompt:p => `-i ${shellQuote(p)}` },
  { kind:'qwen', name:'Qwen Code', bin:'qwen', re:[word('qwen'), /@qwen-code\/qwen-code\b/], prompt:p => `-i ${shellQuote(p)}` },
  { kind:'amp', name:'Amp', bin:'amp', re:[word('amp'), /@sourcegraph\/amp\b/] },
  { kind:'aider', name:'Aider', bin:'aider', re:[word('aider')] },
  { kind:'goose', name:'Goose', bin:'goose', re:[/(?:^|[\s/])goose(?:\s+session)?(?:\s|$)/], start:'goose session' },
  { kind:'crush', name:'Crush', bin:'crush', re:[word('crush')] },
  { kind:'droid', name:'Droid', bin:'droid', re:[word('droid')] },
  { kind:'kiro', name:'Kiro CLI', bin:'kiro-cli', re:[word('kiro-cli')], start:'kiro-cli chat' },
  { kind:'auggie', name:'Auggie', bin:'auggie', re:[word('auggie'), /@augmentcode\/auggie\b/] },
  { kind:'kimi', name:'Kimi CLI', bin:'kimi', re:[word('kimi')] },
];
const byKind = new Map(KINDS.map(k => [k.kind, k]));
export const kindName = kind => byKind.get(kind)?.name || kind;
export const ID = /^([a-z][a-z-]{1,20})\.(\d{1,9})$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// Tools that merely *mention* an agent ("npm i -g @google/gemini-cli", "which gemini", an editor opening a file).
const NOT_AGENT = /(^|\/)(npm|npx|pnpm|yarn|bun|brew|which|man|less|cat|vim?|nvim|nano|code|grep|rg|tail|head|pip3?|uv|pipx|tmux|ps|kill|pkill|pgrep)(\s|$)/;
export function matchKind(args) {
  const a = String(args || '');
  // Only the program and the script it runs decide, never later arguments ("claude 'ask gemini'" is not Gemini).
  const head = a.split(/\s+/).slice(0, 3).join(' ');
  if (NOT_AGENT.test(head.split(/\s+/)[0] || '')) return null;
  return KINDS.find(k => k.re.some(re => re.test(head)))?.kind || null;
}

// ps -axo pid=,ppid=,tty=,args=  →  pid → { pid, ppid, tty, args }
export function parsePs(text) {
  const procs = new Map();
  for (const l of String(text).split('\n')) {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (m) procs.set(Number(m[1]), { pid:Number(m[1]), ppid:Number(m[2]), tty:m[3], args:m[4] });
  }
  return procs;
}

// One agent per terminal: the outermost matching process (agents often relaunch themselves as a child).
export function detect(procs) {
  const found = [];
  for (const p of procs.values()) {
    if (!/^ttys?\w+$/.test(p.tty) || p.pid === process.pid) continue;
    const kind = matchKind(p.args);
    if (!kind) continue;
    const parent = procs.get(p.ppid);
    if (parent && matchKind(parent.args) === kind) continue;
    found.push({ kind, pid:p.pid, tty:`/dev/${p.tty}` });
  }
  return found;
}

async function snapshot() {
  return parsePs((await run('/bin/ps', ['-axo', 'pid=,ppid=,tty=,args='])).stdout);
}

// Working folders of several processes from one lsof call.
async function cwds(pids) {
  const out = new Map();
  if (!pids.length) return out;
  const r = await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], { timeout:8000 });
  let pid = 0;
  for (const line of r.stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) out.set(pid, line.slice(1));
  }
  return out;
}

// Which Mac app a process lives in, from its ancestry: the first ".app/" in a process path.
const APP_NAMES = { 'Visual Studio Code':'VS Code', 'Visual Studio Code - Insiders':'VS Code', Code:'VS Code', iTerm:'iTerm', iTerm2:'iTerm' };
function appOf(procs, pid) {
  for (let p = pid, hops = 0; p > 1 && hops < 25; hops++) {
    const proc = procs.get(p);
    if (!proc) break;
    if (/(^|\/)tmux(:|\s|$)/.test(proc.args)) return 'tmux';
    const app = proc.args.match(/\/([^/]+)\.app\//)?.[1];
    if (app) { const name = app.replace(/\s*\(.*\)$/, ''); return APP_NAMES[name] || name; }
    p = proc.ppid;
  }
  return '';
}

// Readers for agents that keep a transcript, keyed by kind; loaded lazily to keep startup light.
const transcripts = {
  gemini:async (cwd, since) => (await import('./ides.js')).geminiLatestIn(cwd, since),
  opencode:async (cwd, since) => {
    const oc = await import('./opencode.js');
    const s = await oc.latestIn(cwd, since);
    return s ? { title:s.title, status:s.status, messages:await oc.messages(s.id) } : null;
  },
};

const folderName = cwd => path.basename(String(cwd || '')) || '~';
function toSession(a, procs, cwd) {
  const k = byKind.get(a.kind);
  return { harness:'cli', kind:a.kind, kindName:k.name, id:`${a.kind}.${a.pid}`, pid:a.pid, tty:a.tty, cwd:cwd || '', live:true, status:'open',
    title:folderName(cwd), updatedAt:Date.now(), app:appOf(procs, a.pid), startedAt:0 };
}

export async function list() {
  const procs = await snapshot();
  const found = detect(procs);
  const dirs = await cwds(found.map(a => a.pid));
  const out = found.map(a => toSession(a, procs, dirs.get(a.pid)));
  // Titles and working state from the transcript, where there is one.
  await Promise.all(out.map(async s => {
    const t = await transcripts[s.kind]?.(s.cwd).catch(() => null);
    if (!t) return;
    if (t.title) s.title = t.title;
    if (t.status === 'busy') s.status = 'busy';
  }));
  return out;
}

export async function find(id) {
  const m = String(id).match(ID);
  if (!m || !byKind.has(m[1])) throw fail('Bad session id.');
  const pid = Number(m[2]);
  const procs = await snapshot();
  const a = detect(procs).find(x => x.pid === pid && x.kind === m[1]);
  if (!a) throw fail('That agent is no longer running.', 404);
  const s = toSession(a, procs, (await cwds([pid])).get(pid));
  const t = await transcripts[s.kind]?.(s.cwd).catch(() => null);
  if (t?.title) s.title = t.title;
  if (t?.status === 'busy') s.status = 'busy';
  s.hasTranscript = Boolean(transcripts[s.kind]);
  return s;
}

export async function transcript(session) {
  const t = await transcripts[session.kind]?.(session.cwd).catch(() => null);
  return t?.messages || [];
}

// CLIs installed on this Mac, for the "new chat" picker. `which` runs with AgentsEye's extended PATH.
let installedCache = { at:0, list:[] };
export async function installed() {
  if (Date.now() - installedCache.at < 10 * 60000) return installedCache.list;
  const extra = [path.join(HOME, '.local', 'bin'), path.join(HOME, '.opencode', 'bin'), path.join(HOME, '.bun', 'bin'), path.join(HOME, '.npm-global', 'bin')];
  const list = [];
  for (const k of KINDS) {
    const w = await run('/usr/bin/which', [k.bin]);
    if (w.ok || extra.some(d => fs.existsSync(path.join(d, k.bin)))) list.push({ kind:k.kind, name:k.name });
  }
  installedCache = { at:Date.now(), list };
  return list;
}

export function command(kind, prompt = '') {
  const k = byKind.get(kind);
  if (!k) throw fail('Unknown agent.');
  const base = k.start || k.bin;
  return prompt && k.prompt ? `${base} ${prompt.startsWith('-') && !k.prompt('').startsWith('-') ? '-- ' : ''}${k.prompt(prompt)}` : base;
}
export const needsTypedPrompt = kind => !byKind.get(kind)?.prompt;

// The agent a just-opened terminal started, once its process appears.
export async function onTty(tty) {
  return detect(await snapshot()).find(a => a.tty === tty) || null;
}
