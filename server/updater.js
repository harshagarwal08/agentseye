import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './exec.js';
import { DATA, readJson } from './paths.js';

// Installed copies (made by install.sh, in ~/.agentseye/app) keep themselves up to date: every 6 hours they compare
// their version with the repository's and, if newer, download it next to themselves, swap it in and exit so
// launchd restarts them on the new code. Development checkouts never update themselves.
const APP = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const installed = () => APP === path.join(DATA, 'app');
const local = () => readJson(path.join(APP, 'package.json'), {}).version || '0.0.0';
const newer = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
const state = { checkedAt:0, latest:'', updating:false, error:'' };
export const status = () => ({ version:local(), installed:installed(), ...state });

export async function update({ force = false } = {}) {
  const repo = readJson(path.join(DATA, 'install.json'), {}).repo;
  if (!installed() || !repo) return { updated:false, message:'This copy was not installed with install.sh, so it does not update itself.' };
  if (state.updating) return { updated:false, message:'Already updating.' };
  state.checkedAt = Date.now();
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/package.json`).catch(() => null);
  const latest = res?.ok ? (await res.json()).version : '';
  state.latest = latest;
  if (!latest || (!newer(latest, local()) && !force)) return { updated:false, message:`Up to date (${local()}).` };
  state.updating = true;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentseye-update-'));
  try {
    const tarball = path.join(tmp, 'src.tar.gz');
    const dl = await fetch(`https://codeload.github.com/${repo}/tar.gz/HEAD`);
    if (!dl.ok) throw new Error(`Download failed (${dl.status}).`);
    fs.writeFileSync(tarball, Buffer.from(await dl.arrayBuffer()));
    const next = path.join(tmp, 'app');
    fs.mkdirSync(next);
    if (!(await run('/usr/bin/tar', ['-xzf', tarball, '-C', next, '--strip-components', '1'])).ok) throw new Error('Could not unpack the update.');
    const npm = path.join(path.dirname(process.execPath), 'npm');
    const install = await run(fs.existsSync(npm) ? npm : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', next], { timeout:300000 });
    if (!install.ok) throw new Error('Installing the update failed.');
    fs.rmSync(`${APP}.old`, { recursive:true, force:true });
    fs.renameSync(APP, `${APP}.old`);
    fs.renameSync(next, APP);
    fs.rmSync(`${APP}.old`, { recursive:true, force:true });
    // launchd's KeepAlive starts the new version.
    setTimeout(() => process.exit(0), 500);
    return { updated:true, message:`Updated to ${latest}. Restarting…` };
  } catch (error) {
    state.error = error.message;
    return { updated:false, message:error.message };
  } finally {
    state.updating = false;
    fs.rmSync(tmp, { recursive:true, force:true });
  }
}

export function boot() {
  if (!installed()) return;
  setTimeout(() => update().catch(() => {}), 60000).unref();
  setInterval(() => update().catch(() => {}), 6 * 3600 * 1000).unref();
}
