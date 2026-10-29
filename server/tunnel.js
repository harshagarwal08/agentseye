import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, PORT, readJson, writeJson } from './paths.js';
import { run } from './exec.js';

// A Cloudflare Quick Tunnel gives the Mac a public https address without opening any ports.
// Its URL changes whenever cloudflared restarts, so it is saved and shown in Settings.
const settingsFile = path.join(DATA, 'tunnel.json');
const urlFile = path.join(DATA, 'remote-url');
const state = { status:'off', url:'', error:'', child:null, restarts:0 };
const listeners = new Set();

export const enabled = () => Boolean(readJson(settingsFile, {}).enabled);
export const onUrl = fn => listeners.add(fn);
export const remoteHost = () => { try { return state.url ? new URL(state.url).host : ''; } catch { return ''; } };

export async function binary() {
  for (const candidate of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) if (fs.existsSync(candidate)) return candidate;
  const which = await run('/usr/bin/which', ['cloudflared']);
  return which.ok ? which.stdout.trim() : '';
}

export function status() {
  return { enabled:enabled(), status:state.status, url:state.url, error:state.error };
}

export async function start() {
  writeJson(settingsFile, { enabled:true });
  if (state.child) return status();
  const bin = await binary();
  if (!bin) { state.status = 'missing'; state.error = 'cloudflared is not installed.'; return status(); }
  state.status = 'starting';
  state.error = '';
  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio:['ignore', 'pipe', 'pipe'] });
  state.child = child;
  const scan = chunk => {
    const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && match[0] !== state.url) {
      state.url = match[0];
      state.status = 'on';
      state.restarts = 0;
      fs.writeFileSync(urlFile, state.url);
      for (const fn of listeners) fn(state.url);
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('error', error => { state.error = error.message; });
  child.on('exit', () => {
    state.child = null;
    state.url = '';
    if (!enabled()) { state.status = 'off'; return; }
    // Back off so a broken network doesn't spin.
    state.status = 'restarting';
    const delay = Math.min(60000, 2000 * 2 ** state.restarts++);
    setTimeout(() => { if (enabled() && !state.child) start(); }, delay);
  });
  return status();
}

export function stop() {
  writeJson(settingsFile, { enabled:false });
  state.child?.kill();
  state.child = null;
  state.url = '';
  state.status = 'off';
  fs.rmSync(urlFile, { force:true });
  return status();
}

export function boot() { if (enabled()) start(); }
