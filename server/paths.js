import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = process.env.LOOKOUT_USER_HOME || os.homedir();
export const DATA = process.env.LOOKOUT_HOME || path.join(HOME, '.lookout');
export const PORT = Number(process.env.LOOKOUT_PORT || 4480);
fs.mkdirSync(DATA, { recursive:true, mode:0o700 });

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode:0o600 });
  fs.renameSync(tmp, file);
}
