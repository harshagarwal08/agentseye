import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { DATA, readJson, writeJson } from './paths.js';
import { listDevices } from './auth.js';

// Keys are created once per Mac; subscriptions are stored per device so signing a device out stops its pushes.
const keysFile = path.join(DATA, 'push.json');
const subsFile = path.join(DATA, 'push-subscriptions.json');
const recentFile = path.join(DATA, 'push-recent.json');
const DUPLICATE_WINDOW = 60000;

function keys() {
  let k = readJson(keysFile, null);
  if (!k?.publicKey) { k = webpush.generateVAPIDKeys(); writeJson(keysFile, k); }
  return k;
}
export const publicKey = () => keys().publicKey;

const subs = () => readJson(subsFile, {});
export function subscribe(deviceId, subscription) {
  if (!subscription?.endpoint || !/^https:\/\//.test(subscription.endpoint)) throw Object.assign(new Error('Bad subscription.'), { status:400 });
  writeJson(subsFile, { ...subs(), [deviceId]:subscription });
}
export function unsubscribe(deviceId) {
  const all = subs();
  delete all[deviceId];
  writeJson(subsFile, all);
}
export const subscribed = deviceId => Boolean(subs()[deviceId]);

// Keep every push to a short title and one line, including names supplied by agents.
const shortText = (value, limit) => {
  const chars = Array.from(String(value || '').replace(/\s+/g, ' ').trim());
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : chars.join('');
};

export async function notify({ title, body, url = '/', tag }) {
  // Usage warnings from old or concurrent watchers are silenced here too.
  if (/^(?:pace|limit)-claude:/.test(tag || '')) return;
  const message = { title:shortText(title, 60) || 'AgentsEye', body:shortText(body, 100), url, tag };
  const now = Date.now();
  const digest = crypto.createHash('sha256').update(JSON.stringify(message)).digest('hex');
  const recent = Object.fromEntries(Object.entries(readJson(recentFile, {})).filter(([, at]) => Number.isFinite(at) && now - at < DUPLICATE_WINDOW));
  if (tag !== 'test' && recent[digest]) return;
  // Reserve synchronously before sending, so overlapping state callbacks cannot duplicate a push.
  recent[digest] = now;
  writeJson(recentFile, Object.fromEntries(Object.entries(recent).slice(-300)));
  const k = keys();
  // Apple rejects push senders that identify as localhost, so use a real-looking contact (override with AGENTSEYE_PUSH_CONTACT).
  webpush.setVapidDetails(process.env.AGENTSEYE_PUSH_CONTACT || 'mailto:agentseye@users.noreply.github.com', k.publicKey, k.privateKey);
  const all = subs();
  let changed = false;
  // A device that was signed out (or expired) gets nothing more, even if its phone still holds the subscription.
  const live = new Set(listDevices().map(d => d.id));
  for (const device of Object.keys(all)) if (!live.has(device)) { delete all[device]; changed = true; }
  await Promise.all(Object.entries(all).map(async ([device, sub]) => {
    try { await webpush.sendNotification(sub, JSON.stringify(message), { TTL:600 }); }
    catch (error) { if (error.statusCode === 404 || error.statusCode === 410) { delete all[device]; changed = true; } }
  }));
  if (changed) writeJson(subsFile, all);
}
export const hasSubscriptions = () => Object.keys(subs()).length > 0;
