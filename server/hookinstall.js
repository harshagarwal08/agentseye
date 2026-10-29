import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from './paths.js';

const hookScript = fileURLToPath(new URL('../hooks/permission-hook.mjs', import.meta.url));
export const settingsPath = () => process.env.LOOKOUT_CLAUDE_SETTINGS || path.join(HOME, '.claude', 'settings.json');
const command = () => `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)}`;
const ours = hook => typeof hook?.command === 'string' && hook.command.includes('permission-hook.mjs');

function load() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error(`Could not read ${settingsPath()}: ${error.message}`); }
}
function save(settings) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive:true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.lookout-backup`);
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

export function hookStatus() {
  const groups = load().hooks?.PermissionRequest || [];
  return { installed:groups.some(g => (g.hooks || []).some(ours)), settings:settingsPath() };
}

export function installHook() {
  const settings = load();
  settings.hooks ??= {};
  const groups = (settings.hooks.PermissionRequest || []).map(g => ({ ...g, hooks:(g.hooks || []).filter(h => !ours(h)) })).filter(g => g.hooks.length);
  // The timeout must outlast the longest wait Lookout allows (600 s).
  groups.push({ matcher:'*', hooks:[{ type:'command', command:command(), timeout:660 }] });
  settings.hooks.PermissionRequest = groups;
  save(settings);
  return hookStatus();
}

export function uninstallHook() {
  const settings = load();
  const groups = (settings.hooks?.PermissionRequest || []).map(g => ({ ...g, hooks:(g.hooks || []).filter(h => !ours(h)) })).filter(g => g.hooks.length);
  if (!settings.hooks) return hookStatus();
  if (groups.length) settings.hooks.PermissionRequest = groups; else delete settings.hooks.PermissionRequest;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  save(settings);
  return hookStatus();
}
