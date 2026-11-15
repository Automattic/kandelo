export function endpoint(worker, node = false) {
  let seq = 0;
  const pending = new Map();
  const receive = data => {
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id); clearTimeout(task.timer);
    if (data.error) task.reject(Error(data.error)); else task.resolve(data.value);
  };
  const error = e => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(e); }
    pending.clear();
  };
  if (node) { worker.on('message', receive); worker.on('error', error); }
  else { worker.onmessage = e => receive(e.data); worker.onerror = e => error(Error(e.message)); }
  return {
    call(action, data) {
      return new Promise((resolve, reject) => {
        const id = ++seq, timer = setTimeout(() => {
          pending.delete(id); reject(Error(`worker timeout: ${action}`));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, action, data });
      });
    },
    async close() { error(Error('worker closed')); await worker.terminate(); },
  };
}
