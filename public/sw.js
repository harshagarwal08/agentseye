// Push notifications only; Lookout is always live data, so nothing is cached.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch { data = { title:'Lookout', body:event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Lookout', { body:data.body || '', tag:data.tag, data:{ url:data.url || '/' }, icon:'/icon-192.png', badge:'/icon-192.png' }));
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
