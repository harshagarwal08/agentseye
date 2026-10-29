import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { run } from './exec.js';

// Checks are slow (softwareupdate talks to Apple), so results are cached and refreshed in the background.
const state = { checkedAt:0, checking:false, sources:{} };
const jobs = new Map();

const sources = {
  brew:async () => {
    const result = await run('brew', ['outdated', '--json=v2'], { timeout:120000, env:{ HOMEBREW_NO_AUTO_UPDATE:'1' } });
    if (!result.ok && !result.stdout) return { available:false, error:result.stderr.trim() || 'Homebrew not found' };
    return { available:true, items:parseBrew(result.stdout) };
  },
  npm:async () => {
    // npm exits 1 when anything is outdated, so read stdout regardless.
    const result = await run('npm', ['outdated', '-g', '--json'], { timeout:120000 });
    if (!result.stdout.trim() && !result.ok) return { available:false, error:result.stderr.trim() || 'npm not found' };
    return { available:true, items:parseNpm(result.stdout) };
  },
  macos:async () => {
    const result = await run('/usr/sbin/softwareupdate', ['--list'], { timeout:180000 });
    return { available:true, items:parseSoftwareUpdate(result.stdout + result.stderr) };
  },
};

export function parseBrew(text) {
  let data = {};
  try { data = JSON.parse(text); } catch { return []; }
  const items = [];
  for (const f of data.formulae || []) items.push({ id:`formula:${f.name}`, name:f.name, kind:'formula', installed:f.installed_versions?.at(-1) || '', latest:f.current_version, pinned:Boolean(f.pinned) });
  for (const c of data.casks || []) items.push({ id:`cask:${c.name}`, name:c.name, kind:'cask', installed:c.installed_versions?.at?.(-1) || String(c.installed_versions || ''), latest:c.current_version });
  return items;
}

export function parseNpm(text) {
  let data = {};
  try { data = JSON.parse(text || '{}'); } catch { return []; }
  return Object.entries(data)
    .filter(([, v]) => v.current && v.latest && v.current !== v.latest)
    .map(([name, v]) => ({ id:`npm:${name}`, name, kind:'npm', installed:v.current, latest:v.latest }));
}

export function parseSoftwareUpdate(text) {
  const items = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].match(/^\s*\*\s*Label:\s*(.+)$/)?.[1];
    if (!label) continue;
    const details = lines[i + 1] || '';
    const field = name => details.match(new RegExp(`${name}:\\s*([^,]+)`))?.[1]?.trim() || '';
    items.push({ id:`macos:${label}`, name:field('Title') || label, kind:'macos', installed:'', latest:field('Version'), restart:/restart/i.test(field('Action')), recommended:field('Recommended') === 'YES' });
  }
  return items;
}

export function refresh() {
  if (state.checking) return;
  state.checking = true;
  Promise.all(Object.entries(sources).map(async ([key, check]) => {
    try { state.sources[key] = { ...(await check()), checkedAt:Date.now() }; }
    catch (error) { state.sources[key] = { available:false, error:error.message, checkedAt:Date.now() }; }
  })).finally(() => { state.checking = false; state.checkedAt = Date.now(); });
}

export function summary() {
  if (!state.checkedAt && !state.checking) refresh();
  if (state.checkedAt && Date.now() - state.checkedAt > 6 * 3600 * 1000) refresh();
  return { ...state, jobs:[...jobs.values()].slice(-20) };
}

// Upgrades only accept names already reported as outdated, run without a shell, and run one at a time per tool
// (Homebrew holds a lock, so parallel upgrades would fail).
const queues = {};
export function upgrade(id) {
  const items = Object.values(state.sources).flatMap(s => s.items || []);
  const item = items.find(i => i.id === id);
  if (!item) throw Object.assign(new Error('Not in the outdated list; check again first.'), { status:404 });
  const command = {
    formula:['brew', ['upgrade', item.name]],
    cask:['brew', ['upgrade', '--cask', item.name]],
    npm:['npm', ['install', '-g', `${item.name}@latest`]],
  }[item.kind];
  if (!command) throw Object.assign(new Error('macOS updates install from System Settings.'), { status:400 });
  if ([...jobs.values()].some(j => j.itemId === id && (j.status === 'running' || j.status === 'queued'))) throw Object.assign(new Error('Already updating.'), { status:409 });
  const job = { id:crypto.randomUUID(), itemId:id, title:`${command[0]} ${command[1].join(' ')}`, status:'queued', output:'', startedAt:Date.now() };
  jobs.set(job.id, job);
  const tool = command[0];
  queues[tool] = (queues[tool] || Promise.resolve()).then(() => new Promise(resolve => {
    job.status = 'running';
    const child = spawn(command[0], command[1], { env:{ ...process.env, HOMEBREW_NO_AUTO_UPDATE:'1', NONINTERACTIVE:'1' } });
    const append = chunk => { job.output = (job.output + chunk).slice(-20000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', error => { append(`\n${error.message}`); });
    child.on('close', code => {
      job.status = code === 0 ? 'done' : 'failed';
      job.finishedAt = Date.now();
      if (code === 0) for (const s of Object.values(state.sources)) if (s.items) s.items = s.items.filter(i => i.id !== id);
      resolve();
    });
  }));
  return { id:job.id };
}

export function upgradeAll(source) {
  const items = (state.sources[source]?.items || []).filter(i => !i.pinned && i.kind !== 'macos');
  const started = [];
  for (const item of items) { try { started.push(upgrade(item.id).id); } catch {} }
  return { started:started.length };
}

// Runs an install the dashboard offers (currently only cloudflared) through the same job list.
export function brewInstall(name) {
  if (!/^[\w@.+-]+$/.test(name)) throw Object.assign(new Error('Bad package name.'), { status:400 });
  const job = { id:crypto.randomUUID(), itemId:`install:${name}`, title:`brew install ${name}`, status:'queued', output:'', startedAt:Date.now() };
  jobs.set(job.id, job);
  return new Promise(resolve => {
    queues.brew = (queues.brew || Promise.resolve()).then(() => new Promise(done => {
      job.status = 'running';
      const child = spawn('brew', ['install', name], { env:{ ...process.env, HOMEBREW_NO_AUTO_UPDATE:'1', NONINTERACTIVE:'1' } });
      child.stdout.on('data', c => { job.output = (job.output + c).slice(-20000); });
      child.stderr.on('data', c => { job.output = (job.output + c).slice(-20000); });
      child.on('error', e => { job.output += e.message; });
      child.on('close', code => { job.status = code === 0 ? 'done' : 'failed'; job.finishedAt = Date.now(); done(); resolve(job); });
    }));
  });
}
export const installing = name => [...jobs.values()].some(j => j.itemId === `install:${name}` && (j.status === 'running' || j.status === 'queued'));
