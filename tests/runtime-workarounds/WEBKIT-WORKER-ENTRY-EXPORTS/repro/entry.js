let initialized = false;
self.onmessage = async event => {
  if (event.data === 'init') {
    await import('./consumer.js');
    initialized = true;
    self.postMessage('ready');
  } else if (event.data === 'probe') self.postMessage({ initialized });
};
export const helper = value => value;
