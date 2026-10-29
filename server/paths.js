import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = process.env.AGENTSEYE_USER_HOME || os.homedir();
export const DATA = process.env.AGENTSEYE_HOME || path.join(HOME, '.agentseye');
export const PORT = Number(process.env.AGENTSEYE_PORT || 4480);
// AgentsEye used to be called Lookout: carry its password, devices and settings over on first start.
const legacy = path.join(HOME, '.lookout');
if (!process.env.AGENTSEYE_HOME && !fs.existsSync(DATA) && fs.existsSync(legacy)) { try { fs.renameSync(legacy, DATA); } catch {} }
fs.mkdirSync(DATA, { recursive:true, mode:0o700 });

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode:0o600 });
  fs.renameSync(tmp, file);
}
