import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run } from './exec.js';
import { HOME, DATA, readJson, writeJson } from './paths.js';

// Usage limits, read the way each CLI reads them:
// - Claude Code: its OAuth usage endpoint, with the token Claude Code keeps in the macOS Keychain (live, exact).
// - Codex: the rate_limits it records in its session logs (exact, but only as fresh as the last Codex request).
// AgentsEye never refreshes or stores these tokens; if Claude's has expired, opening Claude Code renews it.

const cache = { claude:{ at:0, value:null }, codex:{ at:0, value:null } };

async function claudeToken() {
  const r = await run('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout:5000 });
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout.trim()).claudeAiOauth || null; } catch { return null; }
}

// curl reads the header from stdin so the token never appears in the process list.
function curlJson(url, headers) {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/curl', ['-sS', '--max-time', '10', '-w', '\n%{http_code}', '--config', '-', url]);
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.on('close', () => {
      const cut = out.lastIndexOf('\n');
      const status = Number(out.slice(cut + 1));
      let body = null;
      try { body = JSON.parse(out.slice(0, cut)); } catch {}
      resolve({ status, body });
    });
    child.stdin.end(headers.map(h => `header = "${h.replace(/["\\]/g, '')}"`).join('\n'));
  });
}

const windowLabel = minutes => (minutes <= 300 ? `${Math.round(minutes / 60)}-hour` : minutes >= 10080 ? 'Weekly' : minutes >= 1440 ? `${Math.round(minutes / 1440)}-day` : `${minutes}-min`);

export function parseClaude(body) {
  const windows = [];
  // Each window carries its length, so the phone can tell whether usage is ahead of the clock.
  const add = (key, label, minutes) => {
    const w = body?.[key];
    if (w && typeof w.utilization === 'number') windows.push({ key, label, minutes, percent:Math.round(w.utilization), resetsAt:w.resets_at ? Date.parse(w.resets_at) : null });
  };
  add('five_hour', 'Session (5-hour)', 300);
  add('seven_day', 'Weekly', 10080);
  add('seven_day_opus', 'Weekly · Opus', 10080);
  add('seven_day_sonnet', 'Weekly · Sonnet', 10080);
  return windows;
}

async function claude() {
  const auth = await claudeToken();
  if (!auth?.accessToken) return { harness:'claude', state:'signed-out', note:'Sign in to Claude Code on this Mac.' };
  const r = await curlJson('https://api.anthropic.com/api/oauth/usage', [`Authorization: Bearer ${auth.accessToken}`, 'anthropic-beta: oauth-2025-04-20', 'Content-Type: application/json']);
  if (r.status === 401) return { harness:'claude', state:'stale', plan:auth.subscriptionType, note:'Claude Code needs to refresh its sign-in. Open Claude Code once.' };
  if (r.status !== 200 || !r.body) return { harness:'claude', state:'error', plan:auth.subscriptionType, note:`Usage service unavailable (${r.status || 'offline'}).` };
  return { harness:'claude', state:'ok', plan:auth.subscriptionType || '', windows:parseClaude(r.body), checkedAt:Date.now(), live:true };
}

export function parseCodexRateLimits(rl) {
  if (!rl) return [];
  return ['primary', 'secondary'].map(k => rl[k]).filter(w => w && typeof w.used_percent === 'number')
    .map(w => ({ key:String(w.window_minutes), label:windowLabel(w.window_minutes || 0), minutes:w.window_minutes || 0, percent:Math.round(w.used_percent), resetsAt:w.resets_at ? w.resets_at * 1000 : null }))
    .sort((a, b) => Number(a.key) - Number(b.key));
}

// The newest rollout files hold the latest server-reported limits; read their tails newest first.
async function codex() {
  const root = path.join(HOME, '.codex', 'sessions');
  if (!fs.existsSync(root)) return { harness:'codex', state:'missing', note:'Codex is not set up on this Mac.' };
  const files = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes:true }); } catch { return; }
    for (const e of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (files.length >= 12) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.name.endsWith('.jsonl')) files.push(full);
    }
  };
  walk(root, 0);
  const byTime = files.map(f => ({ f, t:fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of byTime) {
    const size = fs.statSync(f).size;
    const fd = fs.openSync(f, 'r');
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('"rate_limits"')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const rl = e.payload?.rate_limits;
      const windows = parseCodexRateLimits(rl);
      if (windows.length) return { harness:'codex', state:'ok', plan:rl.plan_type || '', windows, checkedAt:Date.parse(e.timestamp) || null, live:false, reached:rl.rate_limit_reached_type || null };
    }
  }
  return { harness:'codex', state:'unknown', note:'No usage reported yet. It appears after your next Codex request.' };
}

// A week of readings, at most one every 10 minutes per limit, for the history chart on the phone.
const historyFile = path.join(DATA, 'usage-history.json');
let history = null;
export function record(list, now = Date.now()) {
  history ??= readJson(historyFile, {});
  let changed = false;
  for (const u of list) for (const w of u.state === 'ok' ? u.windows : []) {
    const points = history[`${u.harness}:${w.key}`] ??= [];
    if (now - (points.at(-1)?.[0] || 0) < 600000) continue;
    points.push([now, w.percent]);
    while (points.length && points[0][0] < now - 8 * 86400000) points.shift();
    changed = true;
  }
  if (changed) writeJson(historyFile, history);
}
export const usageHistory = () => (history ??= readJson(historyFile, {}));

export async function usage({ force = false } = {}) {
  const ttl = { claude:60000, codex:15000 };
  const out = await Promise.all(Object.entries({ claude, codex }).map(async ([key, fn]) => {
    if (!force && cache[key].value && Date.now() - cache[key].at < ttl[key]) return cache[key].value;
    let value;
    try { value = await fn(); } catch (error) { value = { harness:key, state:'error', note:error.message }; }
    cache[key] = { at:Date.now(), value };
    return value;
  }));
  record(out);
  return out;
}
