// Read-only links to one chat, for someone who doesn't have your password. Each link has its own random key that
// travels in the link's #fragment, which browsers never send anywhere, so the relay can't read the chat either.
import crypto from 'node:crypto';
import path from 'node:path';
import { DATA, readJson, writeJson } from './paths.js';

const file = path.join(DATA, 'shares.json');
let shares = readJson(file, []);
const save = () => writeJson(file, shares);
const prune = () => { const before = shares.length; shares = shares.filter(s => s.expiresAt > Date.now()); if (shares.length !== before) save(); };

export function create({ kind, harness = '', agentId, title = '', hours = 24 }) {
  prune();
  const share = { id:crypto.randomBytes(9).toString('base64url'), key:crypto.randomBytes(32).toString('base64'), kind, harness, agentId, title:String(title).slice(0, 120),
    createdAt:Date.now(), expiresAt:Date.now() + Math.min(168, Math.max(1, Number(hours) || 24)) * 3600000 };
  shares.push(share);
  save();
  return share;
}
export function get(id) { prune(); return shares.find(s => s.id === id) || null; }
export const list = () => { prune(); return shares.map(({ key, ...s }) => s); };
export function revoke(id) { shares = shares.filter(s => s.id !== id); save(); }
