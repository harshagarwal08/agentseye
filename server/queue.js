// Messages typed while an agent is working wait here and go out the moment it is free, even with the phone closed.
import crypto from 'node:crypto';
import path from 'node:path';
import { DATA, readJson, writeJson } from './paths.js';

const file = path.join(DATA, 'queue.json');
let items = readJson(file, []);
const save = () => writeJson(file, items);
const keyOf = i => `${i.kind}:${i.harness || ''}:${i.agentId}`;

export function add({ kind, harness = '', agentId, text }) {
  const item = { id:crypto.randomUUID(), kind, harness, agentId, text, createdAt:Date.now() };
  items.push(item);
  save();
  return item;
}
export const forAgent = (kind, agentId) => items.filter(i => i.kind === kind && i.agentId === agentId);
export function remove(id) { items = items.filter(i => i.id !== id); save(); }

// One message per agent per round, oldest first, and not again until the agent has had time to pick it up.
const sentAt = new Map();
export async function flush(isFree, deliver) {
  const seen = new Set();
  for (const item of [...items]) {
    const key = keyOf(item);
    if (seen.has(key) || Date.now() - (sentAt.get(key) || 0) < 15000) continue;
    seen.add(key);
    let free = false;
    try { free = await isFree(item); } catch {}
    if (!free) continue;
    try { await deliver(item); } catch (error) { item.error = error.message; save(); continue; }
    sentAt.set(key, Date.now());
    remove(item.id);
  }
}
