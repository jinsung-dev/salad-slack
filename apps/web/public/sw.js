// Shows Web Push notifications and opens the conversation they are about.
// The server decides who gets one; this only displays it.

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : null;
  if (!data) return;
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      // Same message twice (e.g. two servers) shows once.
      tag: data.tag,
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        open.postMessage({ type: "navigate", url });
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
