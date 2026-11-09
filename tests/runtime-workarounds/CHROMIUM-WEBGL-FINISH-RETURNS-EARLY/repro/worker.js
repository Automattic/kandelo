// The same measurement on an OffscreenCanvas in a dedicated worker.
importScripts('finish.js');
try {
  const gl = new OffscreenCanvas(4, 4).getContext('webgl2', { antialias: false });
  if (!gl) throw Error('WebGL2 unavailable in a worker');
  postMessage(measureFinish(gl));
} catch (error) { postMessage({ failure: String(error) }); }
