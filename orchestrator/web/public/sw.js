// Wakes for a task's push and shows one notice that says only what changed, never a word of what the task did.
const SAID = { "needs-review": "A task needs you", asking: "A task needs you", failed: "A task failed", interrupted: "A task stopped" };

self.addEventListener("push", (event) => {
  const message = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(SAID[message.status] || "A task changed", { tag: message.taskId, data: { taskId: message.taskId } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const to = `/#/tasks/${encodeURIComponent(event.notification.data.taskId)}`;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((open) => {
      const page = open[0];
      return page ? page.focus().then(() => page.navigate(to)) : self.clients.openWindow(to);
    }),
  );
});
