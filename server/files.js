import fs from 'node:fs';
import path from 'node:path';

const kinds = {
  image:['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.heic'],
  video:['.mp4', '.mov', '.webm', '.m4v'],
  audio:['.mp3', '.wav', '.m4a', '.aac', '.ogg'],
  pdf:['.pdf'],
  doc:['.md', '.txt', '.csv', '.json', '.html', '.docx', '.xlsx', '.pptx', '.zip', '.log'],
};
const kindOf = file => Object.entries(kinds).find(([, exts]) => exts.includes(path.extname(file).toLowerCase()))?.[0] || null;
export const mime = {
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml', '.heic':'image/heic',
  '.mp4':'video/mp4', '.mov':'video/quicktime', '.webm':'video/webm', '.m4v':'video/mp4',
  '.mp3':'audio/mpeg', '.wav':'audio/wav', '.m4a':'audio/mp4', '.aac':'audio/aac', '.ogg':'audio/ogg',
  '.pdf':'application/pdf', '.md':'text/plain; charset=utf-8', '.txt':'text/plain; charset=utf-8', '.csv':'text/csv; charset=utf-8',
  '.json':'application/json', '.log':'text/plain; charset=utf-8', '.html':'text/plain; charset=utf-8',
};
const skip = name => name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build' || name === 'vendor' || name === 'Library';

// Newest media and documents in a project, a few folders deep.
export function recentFiles(root, limit = 40) {
  const found = [];
  let budget = 4000;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes:true }); } catch { return; }
    for (const e of entries) {
      if (--budget < 0 || skip(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && kindOf(e.name)) {
        try { const s = fs.statSync(full); found.push({ path:path.relative(root, full), kind:kindOf(e.name), size:s.size, mtime:s.mtimeMs }); } catch {}
      }
    }
  };
  if (root && fs.existsSync(root)) walk(root, 0);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// Resolves symlinks before checking, so nothing outside the project (or hidden) can be served.
export function safePath(root, relative) {
  if (!root || !relative) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(path.resolve(realRoot, relative));
    if (!real.startsWith(realRoot + path.sep)) return null;
    if (path.relative(realRoot, real).split(path.sep).some(skip)) return null;
    if (!kindOf(real) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}
