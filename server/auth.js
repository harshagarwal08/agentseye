import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, readJson, writeJson } from './paths.js';

const authFile = path.join(DATA, 'auth.json');
const devicesFile = path.join(DATA, 'devices.json');
export const tokenFile = path.join(DATA, 'hook-token');
const IDLE_LIMIT = 30 * 24 * 3600 * 1000;
const PAIRING_LIFETIME = 10 * 60 * 1000;

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const scrypt = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const fail = (message, status) => Object.assign(new Error(message), { status });

// Devices are kept by token hash so a leaked devices.json cannot be replayed.
const devices = new Map(Object.entries(readJson(devicesFile, {})));
let saveTimer = null;
const saveDevices = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(devicesFile, Object.fromEntries(devices)), 300);
};
const listeners = new Set();
export const onDeviceWaiting = fn => listeners.add(fn);

export const hasPassword = () => Boolean(readJson(authFile, null)?.hash);

export function setPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw fail('Password must be at least 8 characters.', 400);
  const salt = crypto.randomBytes(16).toString('hex');
  writeJson(authFile, { salt, hash:scrypt(password, salt) });
}

export function checkPassword(password) {
  const record = readJson(authFile, null);
  if (!record?.hash || typeof password !== 'string') return false;
  return crypto.timingSafeEqual(Buffer.from(scrypt(password, record.salt), 'hex'), Buffer.from(record.hash, 'hex'));
}

export function deviceName(userAgent = '') {
  const ua = String(userAgent);
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Device';
  const browser = /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`;
}

// Devices on the Mac itself are trusted straight away; everything through the tunnel waits for approval on the Mac,
// unless it carries a fresh pairing code from the QR shown on the Mac.
export function createDevice({ local, userAgent, ip, paired }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const device = { id:crypto.randomBytes(6).toString('hex'), name:deviceName(userAgent), createdAt:Date.now(), lastSeen:Date.now(), approved:Boolean(local || paired), remote:!local, ip:ip || '' };
  devices.set(sha(token), device);
  saveDevices();
  if (!device.approved) for (const fn of listeners) fn(device);
  return { token, device };
}

export function deviceFor(token) {
  if (!token) return null;
  const key = sha(token);
  const device = devices.get(key);
  if (!device) return null;
  if (Date.now() - device.lastSeen > IDLE_LIMIT) { devices.delete(key); saveDevices(); return null; }
  if (Date.now() - device.lastSeen > 60000) { device.lastSeen = Date.now(); saveDevices(); }
  return device;
}

export function endDevice(token) {
  if (token && devices.delete(sha(token))) saveDevices();
}

export const listDevices = () => [...devices.values()].sort((a, b) => b.lastSeen - a.lastSeen);

export function setApproval(id, approved) {
  for (const [key, device] of devices) {
    if (device.id !== id) continue;
    if (approved) device.approved = true; else devices.delete(key);
    saveDevices();
    return;
  }
  throw fail('Unknown device.', 404);
}

// Small facts a device reports about itself, like whether it was opened from the Home Screen.
export function noteDevice(id, patch) {
  for (const device of devices.values()) if (device.id === id) { Object.assign(device, patch); saveDevices(); }
}

export function signOutOthers(currentId) {
  for (const [key, device] of devices) if (device.id !== currentId) devices.delete(key);
  saveDevices();
}

// One pairing code at a time; it is single-use and expires after ten minutes. It is renewed a minute early
// so a QR on screen never shows a code about to lapse, and stays the same otherwise so the image is stable.
let pairing = null;
export function pairingCode() {
  if (!pairing || Date.now() > pairing.expiresAt - 60000) pairing = { code:crypto.randomBytes(12).toString('base64url'), createdAt:Date.now(), expiresAt:Date.now() + PAIRING_LIFETIME };
  return pairing;
}
export function usePairingCode(code) {
  if (!pairing || !code || Date.now() > pairing.expiresAt) return false;
  const a = Buffer.from(String(code));
  const b = Buffer.from(pairing.code);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  pairing = null;
  return true;
}

// The hook script authenticates with this shared secret instead of a browser session.
export function hookToken() {
  try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token, { mode:0o600 });
  return token;
}
export function validHookToken(given) {
  const expected = Buffer.from(hookToken());
  const actual = Buffer.from(String(given || ''));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Failed sign-ins: 5 per minute per visitor, 20 per hour overall.
const failures = [];
export function loginAllowed(ip) {
  const now = Date.now();
  while (failures.length && failures[0].at < now - 3600000) failures.shift();
  return failures.filter(f => f.ip === ip && f.at > now - 60000).length < 5 && failures.length < 20;
}
export function recordFailure(ip) {
  failures.push({ ip, at:Date.now() });
  return failures.length;
}

export function cookieToken(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)lookout=([^;]+)/);
  return match ? match[1] : '';
}
