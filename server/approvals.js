import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA, readJson, writeJson } from './paths.js';

const settingsFile = path.join(DATA, 'approvals.json');
const pending = new Map();
const history = [];
const listeners = new Set();

// `when`: 'away' sends prompts to the phone only once the Mac has had no keyboard or mouse input for a couple of
// minutes, so at your desk Claude asks in its own window as usual; 'always' sends every prompt.
export const settings = () => ({ hold:true, when:'away', waitSeconds:300, ...readJson(settingsFile, {}) });
const AWAY_AFTER = 120;
export function idleSeconds() {
  return new Promise(resolve => execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout:3000 }, (error, out) => {
    const ns = Number(String(out || '').match(/"HIDIdleTime" = (\d+)/)?.[1]);
    resolve(error || !Number.isFinite(ns) ? Infinity : ns / 1e9);
  }));
}
export function updateSettings(patch) {
  const next = { ...settings() };
  if (typeof patch.hold === 'boolean') next.hold = patch.hold;
  if (['away', 'always'].includes(patch.when)) next.when = patch.when;
  if (Number.isFinite(patch.waitSeconds)) next.waitSeconds = Math.min(600, Math.max(10, Math.round(patch.waitSeconds)));
  writeJson(settingsFile, next);
  return next;
}

const record = (request, decision, by) => {
  const { resolve, timer, ...rest } = request;
  history.unshift({ ...rest, decision, by, decidedAt:Date.now() });
  history.length = Math.min(history.length, 100);
};

// Called by the PermissionRequest hook. `answer` resolves to allow/deny, or null to let Claude show its own dialog.
export function request(input) {
  const base = {
    id:crypto.randomUUID(), createdAt:Date.now(),
    harness:'claude', sessionId:String(input.session_id || ''), cwd:String(input.cwd || ''),
    tool:String(input.tool_name || 'unknown'), input:input.tool_input ?? {},
  };
  const { hold, when, waitSeconds } = settings();
  const answer = (async () => {
    if (!hold) { record(base, 'terminal', 'setting'); return null; }
    if (when === 'away' && await idleSeconds() < AWAY_AFTER) { record(base, 'terminal', 'at the Mac'); return null; }
    return new Promise(resolve => {
      const entry = { ...base, expiresAt:Date.now() + waitSeconds * 1000, resolve };
      entry.timer = setTimeout(() => { pending.delete(entry.id); record(entry, 'terminal', 'timeout'); resolve(null); }, waitSeconds * 1000);
      pending.set(entry.id, entry);
      for (const listener of listeners) listener(entry);
    });
  })();
  return { id:base.id, answer };
}

// Questions Claude asks (AskUserQuestion) are answered by allowing the tool with the answers filled in,
// keyed by each question's text, the same way Claude's own picker does.
export function decide(id, decision, message, answers, always = false) {
  const entry = pending.get(id);
  if (!entry) throw Object.assign(new Error('That request is no longer waiting.'), { status:404 });
  if (!['allow', 'deny'].includes(decision)) throw Object.assign(new Error('Decision must be allow or deny.'), { status:400 });
  if (decision === 'allow' && entry.tool === 'AskUserQuestion' && !answers) throw Object.assign(new Error('Pick an answer first.'), { status:400 });
  if (always && decision === 'allow') remember(entry);
  clearTimeout(entry.timer);
  pending.delete(id);
  record(entry, decision, always ? 'always' : 'dashboard');
  const out = { decision, message:message || (decision === 'deny' ? 'Denied from AgentsEye.' : '') };
  if (decision === 'allow' && answers && entry.tool === 'AskUserQuestion') out.updatedInput = { ...entry.input, answers };
  entry.resolve(out);
}

// "Always allow" adds a rule to the project's .claude/settings.local.json (Claude's own per-project, uncommitted
// settings), so Claude stops asking for the same thing in that project: the exact command, or the tool.
export function ruleFor(entry) {
  const i = entry.input || {};
  if (entry.tool === 'Bash' && i.command) {
    // In Claude's rules * is a wildcard and chained commands widen what a rule covers, so only plain commands qualify.
    if (/[*\n]|&&|\|\||[;|`]|\$\(/.test(i.command)) throw Object.assign(new Error('This command is too broad to always allow. Allow it once instead.'), { status:400 });
    return `Bash(${String(i.command).replace(/\)/g, '\\)')})`;
  }
  if (entry.tool === 'WebFetch' && i.url) { try { return `WebFetch(domain:${new URL(i.url).hostname})`; } catch {} }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(entry.tool)) return 'Edit';
  return entry.tool;
}
function remember(entry) {
  if (!entry.cwd || !fs.existsSync(entry.cwd)) throw Object.assign(new Error('No project folder to save the rule in.'), { status:400 });
  const file = path.join(entry.cwd, '.claude', 'settings.local.json');
  const current = readJson(file, {});
  const allow = new Set(current.permissions?.allow || []);
  allow.add(ruleFor(entry));
  fs.mkdirSync(path.dirname(file), { recursive:true });
  writeJson(file, { ...current, permissions:{ ...current.permissions, allow:[...allow] } });
}

// If Claude gives up (user answered in the terminal, session closed), the hook disconnects and we drop the card.
export function cancel(id) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  record(entry, 'terminal', 'answered elsewhere');
}

export const list = () => ({
  pending:[...pending.values()].map(({ resolve, timer, ...e }) => e),
  history:history.slice(0, 50),
  settings:settings(),
});
export const onRequest = fn => { listeners.add(fn); return () => listeners.delete(fn); };
