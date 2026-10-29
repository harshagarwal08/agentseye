import path from 'node:path';
import webpush from 'web-push';
import { DATA, readJson, writeJson } from './paths.js';

// Keys are created once per Mac; subscriptions are stored per device so signing a device out stops its pushes.
const keysFile = path.join(DATA, 'push.json');
const subsFile = path.join(DATA, 'push-subscriptions.json');

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

export async function notify({ title, body, url = '/', tag }) {
  const k = keys();
  webpush.setVapidDetails('mailto:lookout@localhost', k.publicKey, k.privateKey);
  const all = subs();
  let changed = false;
  await Promise.all(Object.entries(all).map(async ([device, sub]) => {
    try { await webpush.sendNotification(sub, JSON.stringify({ title, body, url, tag }), { TTL:600 }); }
    catch (error) { if (error.statusCode === 404 || error.statusCode === 410) { delete all[device]; changed = true; } }
  }));
  if (changed) writeJson(subsFile, all);
}
export const hasSubscriptions = () => Object.keys(subs()).length > 0;
