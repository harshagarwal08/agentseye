import { spawn } from 'node:child_process';
import path from 'node:path';
import { run } from './exec.js';
import { DATA, readJson, writeJson } from './paths.js';

// Keeping agents alive while you are away:
// - Keep awake: AgentsEye holds a `caffeinate` assertion, so idle sleep never stops your agents. The display may
//   still turn off (and lock); macOS still sleeps when the lid closes.
// - Lid closed: macOS only keeps running with the lid shut if sleep is disabled system-wide (`pmset disablesleep`).
//   That needs an administrator password, so it can only be switched on the Mac itself.
const file = path.join(DATA, 'power.json');
let caffeinate = null;

export const settings = () => ({ keepAwake:'plugged', ...readJson(file, {}) });

export function apply() {
  const mode = settings().keepAwake;
  caffeinate?.kill();
  caffeinate = null;
  if (mode === 'off') return;
  // -s holds the system awake only on AC power; -i also covers battery.
  caffeinate = spawn('/usr/bin/caffeinate', mode === 'always' ? ['-i', '-s', '-w', String(process.pid)] : ['-s', '-w', String(process.pid)], { stdio:'ignore' });
  caffeinate.on('exit', () => { caffeinate = null; });
}

export function setKeepAwake(mode) {
  if (!['off', 'plugged', 'always'].includes(mode)) throw Object.assign(new Error('Unknown mode.'), { status:400 });
  writeJson(file, { ...settings(), keepAwake:mode });
  apply();
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

export async function sleepNow() { await run('/usr/bin/pmset', ['sleepnow']); }
