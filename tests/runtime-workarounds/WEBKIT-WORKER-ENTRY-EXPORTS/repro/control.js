let initialized = false;
self.onmessage = async event => {
  if (event.data === 'init') {
    const helper = value => value;
    await Promise.resolve(helper(1));
    initialized = true;
    self.postMessage('ready');
  } else if (event.data === 'probe') self.postMessage({ initialized });
};
