import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import { HOME } from './paths.js';

export async function stats() {
  const [vm, df, batt] = await Promise.all([run('/usr/bin/vm_stat'), run('/bin/df', ['-k', '/System/Volumes/Data']), run('/usr/bin/pmset', ['-g', 'batt'])]);
  return {
    host:os.hostname(),
    os:`macOS ${(await run('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim()}`,
    cpus:os.cpus().length,
    cpuModel:os.cpus()[0]?.model || '',
    load:os.loadavg(),
    uptime:os.uptime(),
    memory:parseMemory(vm.stdout, os.totalmem()),
    disk:parseDisk(df.stdout),
    battery:parseBattery(batt.stdout),
  };
}

// "Used" matches Activity Monitor: app (active + wired) plus compressed pages; cached files count as free.
export function parseMemory(text, total) {
  const pageSize = Number(text.match(/page size of (\d+)/)?.[1] || 16384);
  const pages = name => Number(text.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] || 0);
  const used = (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * pageSize;
  return { total, used:Math.min(used, total) };
}

export function parseDisk(text) {
  const line = text.trim().split('\n')[1];
  if (!line) return null;
  const parts = line.trim().split(/\s+/);
  return { total:Number(parts[1]) * 1024, used:Number(parts[2]) * 1024, free:Number(parts[3]) * 1024 };
}

export function parseBattery(text) {
  const match = text.match(/(\d+)%;\s*([^;]+);/);
  if (!match) return null;
  return { percent:Number(match[1]), state:match[2].trim(), source:/AC Power/.test(text) ? 'AC' : 'Battery' };
}

export async function processes() {
  const result = await run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,user=,%cpu=,%mem=,rss=,etime=,command=']);
  return parseProcesses(result.stdout);
}

export function parseProcesses(text) {
  const list = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const command = m[8];
    // Apps run from bundles named "Foo.app/Contents/MacOS/Foo"; the bundle name reads better.
    const exe = command.match(/^(.*?\.app)\/Contents\/MacOS\/([^ ]+)/);
    const name = exe ? path.basename(exe[1], '.app') : path.basename(command.split(' ')[0]);
    list.push({ pid:Number(m[1]), ppid:Number(m[2]), user:m[3], cpu:Number(m[4]), mem:Number(m[5]), rss:Number(m[6]) * 1024, elapsed:m[7], name, command });
  }
  return list;
}

export async function ports() {
  const result = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-iUDP', '-F', 'pcLPn'], { timeout:15000 });
  return parseLsof(result.stdout);
}

// lsof -F prints one field per line: p/c/L start a process, P/n describe each of its sockets.
export function parseLsof(text) {
  const out = [];
  const seen = new Set();
  let proc = {};
  let protocol = '';
  for (const line of text.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') { proc = { pid:Number(value) }; protocol = ''; }
    else if (tag === 'c') proc.command = value;
    else if (tag === 'L') proc.user = value;
    else if (tag === 'P') protocol = value;
    else if (tag === 'n') {
      if (protocol === 'UDP' && value.includes('->')) continue;
      const m = value.match(/^(.*):(\d+|\*)$/);
      if (!m || m[2] === '*') continue;
      const key = `${proc.pid}|${protocol}|${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const address = m[1].replace(/^\[|\]$/g, '');
      out.push({ ...proc, protocol, address, port:Number(m[2]), exposed:!['127.0.0.1', '::1', 'localhost'].includes(address) });
    }
  }
  return out.sort((a, b) => a.port - b.port);
}

export function killProcess(pid, signal = 'SIGTERM') {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw Object.assign(new Error('That process cannot be stopped from here.'), { status:400 });
  if (!['SIGTERM', 'SIGKILL'].includes(signal)) throw Object.assign(new Error('Unsupported signal.'), { status:400 });
  try { process.kill(pid, signal); } catch (error) {
    throw Object.assign(new Error(error.code === 'EPERM' ? 'Permission denied: that process belongs to another user (needs sudo).' : error.message), { status:400 });
  }
}

const startupDirs = () => [
  { dir:path.join(HOME, 'Library/LaunchAgents'), scope:'user' },
  { dir:'/Library/LaunchAgents', scope:'global-agent' },
  { dir:'/Library/LaunchDaemons', scope:'daemon' },
];

// plutil takes ~50 ms per file and plists rarely change, so parse each once per modification.
const plistCache = new Map();
async function readPlist(file) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return {}; }
  const hit = plistCache.get(file);
  if (hit?.mtime === mtime) return hit.plist;
  const json = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]);
  let plist = {};
  try { plist = JSON.parse(json.stdout); } catch {}
  plistCache.set(file, { mtime, plist });
  return plist;
}

export async function startupItems() {
  const uid = process.getuid();
  const listed = parseLaunchctlList((await run('/bin/launchctl', ['list'])).stdout);
  const items = [];
  for (const { dir, scope } of startupDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.plist')); } catch { continue; }
    const parsed = await Promise.all(files.map(async file => {
      const full = path.join(dir, file);
      const plist = await readPlist(full);
      const label = plist.Label || file.replace(/\.plist$/, '');
      const state = listed.get(label);
      return {
        label, scope, file:full,
        program:plist.Program || (plist.ProgramArguments || []).join(' '),
        runAtLoad:Boolean(plist.RunAtLoad), keepAlive:Boolean(plist.KeepAlive), disabled:Boolean(plist.Disabled),
        loaded:Boolean(state), pid:state?.pid || null, lastExit:state?.status ?? null,
        // Daemons live in the system domain, which only root can change.
        controllable:scope !== 'daemon', domain:scope === 'daemon' ? 'system' : `gui/${uid}`,
      };
    }));
    items.push(...parsed);
  }
  return items.sort((a, b) => a.label.localeCompare(b.label));
}

export function parseLaunchctlList(text) {
  const map = new Map();
  for (const line of text.split('\n').slice(1)) {
    const [pid, status, label] = line.split('\t');
    if (label) map.set(label, { pid:pid === '-' ? null : Number(pid), status:Number(status) });
  }
  return map;
}

export async function startupAction(label, action) {
  const item = (await startupItems()).find(i => i.label === label);
  if (!item) throw Object.assign(new Error('Unknown startup item.'), { status:404 });
  if (!item.controllable) throw Object.assign(new Error('System daemons need sudo; change them in Terminal.'), { status:400 });
  const target = `${item.domain}/${label}`;
  const commands = {
    stop:['bootout', target],
    start:['bootstrap', item.domain, item.file],
    disable:['disable', target],
    enable:['enable', target],
  }[action];
  if (!commands) throw Object.assign(new Error('Unknown action.'), { status:400 });
  const result = await run('/bin/launchctl', commands);
  if (!result.ok) throw Object.assign(new Error((result.stderr || result.stdout || 'launchctl failed').trim()), { status:400 });
  return { ok:true };
}

export async function reveal(file) {
  await run('/usr/bin/open', ['-R', file]);
}
