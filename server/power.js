import { spawn } from 'node:child_process';
import path from 'node:path';
import { run } from './exec.js';
import { DATA, readJson, writeJson } from './paths.js';

// Keeping agents alive while you are away:
// - Keep awake: AgentsEye holds a `caffeinate -i` assertion, so idle sleep never stops your agents. (`-s` alone
//   isn't enough: macOS still drops into dark wake on idle, which pauses agents and the relay link.) The display may
//   still turn off (and lock); macOS still sleeps when the lid closes.
// - Lid closed: macOS only keeps running with the lid shut if sleep is disabled system-wide (`pmset disablesleep`).
//   That needs an administrator password, so it can only be switched on the Mac itself.
const file = path.join(DATA, 'power.json');
let caffeinate = null;
let watch = null;

export const settings = () => ({ keepAwake:'plugged', ...readJson(file, {}) });
const onPower = async () => /AC Power/.test((await run('/usr/bin/pmset', ['-g', 'ps'])).stdout);

// "When plugged in" follows the charger: checked every 30 seconds, held only while on power.
export async function apply() {
  const mode = settings().keepAwake;
  const want = mode === 'always' || (mode === 'plugged' && await onPower());
  if (mode === 'plugged') watch ||= setInterval(() => apply().catch(() => {}), 30000).unref();
  else { clearInterval(watch); watch = null; }
  if (want === Boolean(caffeinate)) return;
  caffeinate?.kill();
  caffeinate = null;
  if (!want) return;
  const proc = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio:'ignore' });
  proc.on('exit', () => { if (caffeinate === proc) caffeinate = null; });
  caffeinate = proc;
}

export async function setKeepAwake(mode) {
  if (!['off', 'plugged', 'always'].includes(mode)) throw Object.assign(new Error('Unknown mode.'), { status:400 });
  writeJson(file, { ...settings(), keepAwake:mode });
  await apply();
  return status();
}

export async function status() {
  const [pm, ps, lock] = await Promise.all([run('/usr/bin/pmset', ['-g']), run('/usr/bin/pmset', ['-g', 'ps']), run('/usr/sbin/sysadminctl', ['-screenLock', 'status'])]);
  return {
    keepAwake:settings().keepAwake,
    holding:Boolean(caffeinate),
    onPower:/AC Power/.test(ps.stdout),
    lidClosedOk:/SleepDisabled\s+1/.test(pm.stdout),
    // Locking works by turning the display off, which only locks if the password is asked for right away.
    lockImmediate:/immediate/.test(lock.stdout + lock.stderr),
  };
}

export async function lock() {
  const s = await status();
  if (!s.lockImmediate) throw Object.assign(new Error('Turn on "Require password immediately" in System Settings → Lock Screen first.'), { status:409 });
  await run('/usr/bin/pmset', ['displaysleepnow']);
}

// Asks for the admin password in a macOS dialog on the Mac; nothing is stored.
export async function setLidClosed(on) {
  const r = await run('/usr/bin/osascript', ['-e', `do shell script "/usr/bin/pmset -a disablesleep ${on ? 1 : 0}" with administrator privileges`], { timeout:120000 });
  if (!r.ok) throw Object.assign(new Error(/cancel/i.test(r.stderr) ? 'Cancelled.' : r.stderr.trim() || 'Could not change the setting.'), { status:400 });
  return status();
}

// The Mac's battery, from `pmset -g batt`: null on Macs without one.
export function parseBattery(text) {
  const m = String(text).match(/(\d+)%;\s*([^;]+);\s*(?:(\d+:\d+) remaining)?/);
  if (!m) return null;
  const state = m[2].trim();
  return { percent:Number(m[1]), plugged:/AC Power/.test(text), charging:state === 'charging', remaining:m[3] && m[3] !== '0:00' ? m[3] : '' };
}
export async function battery() { return parseBattery((await run('/usr/bin/pmset', ['-g', 'batt'])).stdout); }

export async function sleepNow() { await run('/usr/bin/pmset', ['sleepnow']); }
