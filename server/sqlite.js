import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Reads another app's SQLite database with the sqlite3 that ships with macOS, read only. If the app holds a write
// lock, fall back to a snapshot read rather than wait. Returns [] when the file or table isn't there.
export async function sqliteJson(db, query, { timeout = 15000 } = {}) {
  for (const uri of [`file:${db}?mode=ro`, `file:${db}?immutable=1`]) {
    try {
      const { stdout } = await run('/usr/bin/sqlite3', ['-readonly', '-json', uri, query], { maxBuffer:64 * 1024 * 1024, timeout });
      return stdout.trim() ? JSON.parse(stdout) : [];
    } catch {}
  }
  return [];
}
export const sqlQuote = s => `'${String(s).replace(/'/g, "''")}'`;
