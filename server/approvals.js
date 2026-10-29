import crypto from 'node:crypto';
import path from 'node:path';
import { DATA, readJson, writeJson } from './paths.js';

const settingsFile = path.join(DATA, 'approvals.json');
const pending = new Map();
const history = [];
const listeners = new Set();

export const settings = () => ({ hold:true, waitSeconds:300, ...readJson(settingsFile, {}) });
export function updateSettings(patch) {
  const next = { ...settings() };
  if (typeof patch.hold === 'boolean') next.hold = patch.hold;
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
  const { hold, waitSeconds } = settings();
  if (!hold) { record(base, 'terminal', 'setting'); return { id:base.id, answer:Promise.resolve(null) }; }
  const answer = new Promise(resolve => {
    const entry = { ...base, expiresAt:Date.now() + waitSeconds * 1000, resolve };
    entry.timer = setTimeout(() => { pending.delete(entry.id); record(entry, 'terminal', 'timeout'); resolve(null); }, waitSeconds * 1000);
    pending.set(entry.id, entry);
    for (const listener of listeners) listener(entry);
  });
  return { id:base.id, answer };
}

export function decide(id, decision, message) {
  const entry = pending.get(id);
  if (!entry) throw Object.assign(new Error('That request is no longer waiting.'), { status:404 });
  if (!['allow', 'deny'].includes(decision)) throw Object.assign(new Error('Decision must be allow or deny.'), { status:400 });
  clearTimeout(entry.timer);
  pending.delete(id);
  record(entry, decision, 'dashboard');
  entry.resolve({ decision, message:message || (decision === 'deny' ? 'Denied from AgentsEye.' : '') });
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
