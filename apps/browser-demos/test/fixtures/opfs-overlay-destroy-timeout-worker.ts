const queuedMessages: MessageEvent[] = [];
self.onmessage = (event) => queuedMessages.push(event);

await import("../../../../host/src/browser-kernel-worker-entry");
const handleMessage = self.onmessage;
if (handleMessage === null) throw new Error("kernel worker did not install its message handler");
self.onmessage = (event) => {
  if (event.data?.type !== "destroy") handleMessage.call(self, event);
};
for (const event of queuedMessages) self.onmessage.call(self, event);
