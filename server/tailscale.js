import fs from 'node:fs';
import { run } from './exec.js';
import { PORT } from './paths.js';

// Tailscale gives the Mac a private https address (https://<mac>.<tailnet>.ts.net) that never changes and is
// only reachable from your own devices signed in to the same Tailscale account. `tailscale serve` handles TLS
// and forwards to AgentsEye on loopback, so AgentsEye itself never listens on the network.
const candidates = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];
let host = '';
export const remoteHost = () => host;

async function cli() {
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const w = await run('/usr/bin/which', ['tailscale']);
  return w.ok ? w.stdout.trim() : '';
}

export function parseStatus(json) {
  let s = {};
  try { s = JSON.parse(json); } catch { return { state:'error' }; }
  const dns = String(s.Self?.DNSName || '').replace(/\.$/, '');
  return { state:s.BackendState === 'Running' ? 'running' : s.BackendState === 'NeedsLogin' ? 'signed-out' : 'stopped', dns };
}

export async function status() {
  const bin = await cli();
  if (!bin) return { state:'missing' };
  const st = parseStatus((await run(bin, ['status', '--json'])).stdout);
  if (st.state !== 'running') { host = ''; return st; }
  const serve = await run(bin, ['serve', 'status', '--json']);
  const serving = serve.stdout.includes(`127.0.0.1:${PORT}`);
  host = serving ? st.dns : '';
  return { ...st, serving, url:serving ? `https://${st.dns}` : '' };
}

export async function setServing(on) {
  const bin = await cli();
  if (!bin) throw Object.assign(new Error('Tailscale is not installed.'), { status:409 });
  const r = on ? await run(bin, ['serve', '--bg', '--https=443', `http://127.0.0.1:${PORT}`], { timeout:30000 })
    : await run(bin, ['serve', '--https=443', 'off'], { timeout:30000 });
  if (!r.ok) throw Object.assign(new Error((r.stderr || r.stdout).trim().split('\n')[0] || 'Tailscale refused.'), { status:400 });
  return status();
}

// Learn the address at startup so phones can connect before anyone opens Settings.
export function boot() { status().catch(() => {}); setInterval(() => status().catch(() => {}), 60000).unref(); }
