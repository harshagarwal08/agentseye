// End-to-end encryption between your phone and your Mac, for when traffic goes through a relay.
// Both sides derive the same AES key from your Lookout password (PBKDF2, salted per Mac), so the relay and any
// company proxy in between only ever see ciphertext. Runs unchanged in browsers and in Node (WebCrypto).
export const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

// Large payloads (file downloads) overflow String.fromCharCode's argument limit, so encode in slices.
export function b64(bytes) {
  const view = new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i += 0x8000) out += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(out);
}

export async function deriveKeyBytes(password, saltB64, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', hash:'SHA-256', salt:unb64(saltB64), iterations }, base, 256);
  return new Uint8Array(bits);
}

export const importKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

// The additional data ties each message to its direction and request, so a reply can't be replayed as a
// request or matched to a different request.
export async function seal(key, value, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData:enc.encode(aad) }, key, enc.encode(JSON.stringify(value)));
  return { v:1, iv:b64(iv), ct:b64(ct) };
}

export async function open(key, box, aad) {
  if (!box || box.v !== 1) throw new Error('Not an encrypted message.');
  const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv:unb64(box.iv), additionalData:enc.encode(aad) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}

export const requestAad = nonce => `lookout-e2e-v1|req|${nonce}`;
export const responseAad = nonce => `lookout-e2e-v1|res|${nonce}`;
