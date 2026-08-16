/* Push event handler — imported into the Workbox-generated service worker. */

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}

  var title = data.title || 'CP Five Star';
  var body = data.body || 'You have a new notification.';
  var url = data.url || '/owner';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      tag: 'cp-stock-in',
      renotify: true,
      data: { url: url },
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/owner';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
