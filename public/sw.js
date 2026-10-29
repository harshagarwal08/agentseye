// The app shell (HTML, CSS, scripts, icons) is cached so Lookout opens instantly from the Home Screen and can
// show "Can't reach your Mac" offline. It is network-first, so a new version shows up on the next open.
// Live data (/api) is never cached.
const SHELL = 'lookout-shell-v4';
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
  event.respondWith(fetch(event.request).then(res => {
    if (res.ok && (FILES.includes(key) || event.request.mode === 'navigate')) caches.open(SHELL).then(c => c.put(key, res.clone()));
    return res;
  }).catch(() => caches.match(key).then(hit => hit || Response.error())));
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch { data = { title:'Lookout', body:event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Lookout', { body:data.body || '', tag:data.tag, renotify:Boolean(data.tag), data:{ url:data.url || '/' }, icon:'/icon-192.png', badge:'/icon-192.png' }));
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
