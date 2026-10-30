// What an agent changed in its project, and committing it, from the phone. Only folders that belong to an agent
// AgentsEye knows about are ever touched (the caller resolves the folder from the agent, never from the phone).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function git(cwd, args, { timeout = 20000, ok = false } = {}) {
  return new Promise((resolve, reject) => execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer:8 * 1024 * 1024, env:{ ...process.env, GIT_TERMINAL_PROMPT:'0' } }, (error, stdout, stderr) => {
    if (error && !ok) reject(fail((stderr || error.message).trim().split('\n').slice(-3).join(' '), 409));
    else resolve(stdout);
  }));
}

export async function status(cwd) {
  if (!cwd || !fs.existsSync(cwd)) throw fail('This agent has no project folder.', 404);
  const top = (await git(cwd, ['rev-parse', '--show-toplevel'], { ok:true })).trim();
  if (!top) return { repo:false };
  const head = await git(cwd, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
  const parts = head.split('\0').filter(Boolean);
  const branchLine = parts[0]?.startsWith('## ') ? parts.shift().slice(3) : '';
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const file = parts[i].slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++;
    files.push({ path:file, status:code.includes('?') ? 'new' : code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : code.includes('R') ? 'renamed' : 'modified', add:0, del:0 });
  }
  const numstat = await git(cwd, ['diff', 'HEAD', '--numstat'], { ok:true });
  for (const line of numstat.split('\n')) {
    const [add, del, file] = line.split('\t');
    const f = files.find(x => x.path === file);
    if (f) Object.assign(f, { add:Number(add) || 0, del:Number(del) || 0 });
  }
  for (const f of files.filter(x => x.status === 'new')) {
    try { const text = fs.readFileSync(path.join(top, f.path), 'utf8'); f.add = text ? text.split('\n').length : 0; } catch {}
  }
  const [branch, tracking = ''] = branchLine.split('...');
  return { repo:true, root:top, branch:branch.replace(/^No commits yet on /, ''), upstream:tracking.replace(/\s*\[.*$/, ''),
    ahead:Number(branchLine.match(/ahead (\d+)/)?.[1] || 0), behind:Number(branchLine.match(/behind (\d+)/)?.[1] || 0), files:files.slice(0, 300) };
}

export async function diff(cwd, file) {
  const s = await status(cwd);
  const f = s.files?.find(x => x.path === file);
  if (!f) throw fail('That file has no changes.', 404);
  const text = f.status === 'new'
    ? await git(s.root, ['diff', '--no-index', '--', '/dev/null', file], { ok:true })
    : await git(s.root, ['diff', 'HEAD', '--', file]);
  return { file, diff:text.length > 200000 ? `${text.slice(0, 200000)}\n… (cut, the change is very large)` : text };
}

export async function commit(cwd, message, push) {
  const s = await status(cwd);
  if (!s.repo) throw fail('Not a git repository.');
  if (!s.files.length) throw fail('Nothing to commit.');
  const msg = String(message || '').trim();
  if (!msg) throw fail('Write a commit message first.');
  await git(s.root, ['add', '-A']);
  await git(s.root, ['commit', '-m', msg]);
  let pushed = false;
  if (push) {
    await git(s.root, s.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'], { timeout:90000 });
    pushed = true;
  }
  return { ok:true, pushed, ...(await status(cwd)) };
}

export async function push(cwd) {
  const s = await status(cwd);
  await git(s.root, s.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'], { timeout:90000 });
  return status(cwd);
}

// Pull requests through the GitHub CLI and its own login. The service's PATH is minimal, so look in the usual places.
const ghPath = () => ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'].find(p => fs.existsSync(p)) || 'gh';
function gh(cwd, args, { timeout = 30000, ok = false } = {}) {
  return new Promise((resolve, reject) => execFile(ghPath(), args, { cwd, timeout, maxBuffer:8 * 1024 * 1024, env:{ ...process.env, GH_PROMPT_DISABLED:'1', NO_COLOR:'1' } }, (error, stdout, stderr) => {
    if (error && !ok) reject(fail((stderr || error.message).trim().split('\n').slice(-2).join(' '), error.code === 'ENOENT' ? 404 : 409));
    else resolve(error ? null : stdout);
  }));
}
const checkState = c => {
  const v = String(c.conclusion || c.state || c.status || '').toUpperCase();
  return ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v) ? 'pass' : ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v) ? 'fail' : 'pending';
};

// The pull request for the folder's current branch, with its checks summed up.
export async function pr(cwd) {
  if (!fs.existsSync(ghPath()) && ghPath() === 'gh') return { available:false, reason:'Install the GitHub CLI (gh) on your Mac and sign in to see pull requests here.' };
  const out = await gh(cwd, ['pr', 'view', '--json', 'number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup,headRefName,baseRefName,additions,deletions,comments'], { ok:true });
  if (!out) return { available:true, pr:null };
  const p = JSON.parse(out);
  const checks = (p.statusCheckRollup || []).map(c => ({ name:c.name || c.context || 'check', state:checkState(c), url:c.detailsUrl || c.targetUrl || '' }));
  return { available:true, pr:{
    number:p.number, title:p.title, url:p.url, state:p.state, draft:p.isDraft, mergeable:p.mergeable, review:p.reviewDecision || '',
    head:p.headRefName, base:p.baseRefName, additions:p.additions, deletions:p.deletions, comments:(p.comments || []).length,
    checks, summary:{ pass:checks.filter(c => c.state === 'pass').length, fail:checks.filter(c => c.state === 'fail').length, pending:checks.filter(c => c.state === 'pending').length },
  } };
}
export async function prMerge(cwd, number) {
  await gh(cwd, ['pr', 'merge', String(Number(number)), '--squash'], { timeout:90000 });
  return pr(cwd);
}
export async function prComment(cwd, number, body) {
  const text = String(body || '').trim();
  if (!text) throw fail('Write a comment first.');
  await gh(cwd, ['pr', 'comment', String(Number(number)), '--body', text.slice(0, 20000)]);
  return pr(cwd);
}
