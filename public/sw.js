// The app shell (HTML, CSS, scripts, icons) is cached so AgentsEye opens instantly from the Home Screen and can
// show "Can't reach your Mac" offline. It is network-first, so a new version shows up on the next open.
// Live data (/api) is never cached.
const SHELL = 'agentseye-shell-v6';
const FILES = ['/', '/index.html', '/style.css', '/app.js', '/avatars.js', '/markdown.js', '/e2e.js', '/icon.svg', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/hook/')) return;
  const key = event.request.mode === 'navigate' ? '/' : url.pathname;
  // Always ask the Mac first and skip the browser's own cache, so a new version shows on the next open.
  event.respondWith(fetch(event.request, { cache:'no-store' }).then(async res => {
    // The relay answers 503 while the Mac is offline; open the saved app instead, which shows a proper offline screen.
    if (res.status >= 502) return (await caches.match(key)) || res;
    // Copy now: by the time the cache opens, the page will have read the original.
    if (res.ok && (FILES.includes(key) || event.request.mode === 'navigate')) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then(hit => hit || Response.error())));
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch { data = { title:'AgentsEye', body:event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'AgentsEye', { body:data.body || '', tag:data.tag, renotify:Boolean(data.tag), data:{ url:data.url || '/' }, icon:'/icon-192.png', badge:'/icon-192.png' }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === self.location.origin);
    if (open) { open.navigate(url); return open.focus(); }
    return self.clients.openWindow(url);
  }));
});
