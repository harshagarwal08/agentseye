import { execFile } from 'node:child_process';
import path from 'node:path';

// launchd starts us with a bare PATH; add the usual tool locations so brew, npm, claude and codex resolve.
const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.dirname(process.execPath), `${process.env.HOME}/.local/bin`];
process.env.PATH = [...new Set([...(process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':'), ...extra])].join(':');

// Never throws: callers get ok/code/stdout/stderr and decide what a failure means.
export function run(cmd, args = [], { timeout = 10000, maxBuffer = 64 << 20, env } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { encoding:'utf8', timeout, maxBuffer, env: env ? { ...process.env, ...env } : process.env }, (error, stdout, stderr) => {
      resolve({ ok:!error, code:error ? (error.code ?? 1) : 0, stdout:stdout || '', stderr:stderr || '', timedOut:Boolean(error?.killed) });
    });
  });
}

export const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
