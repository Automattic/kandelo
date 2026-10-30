let readback = false;
onmessage = ({data}) => {
  if (data.kind === 'health') {
    const {gl, source, scene} = globalThis.planes;
    postMessage({kind: 'health', sceneLost: gl.isContextLost(),
      sourceLost: source.isContextLost(), sceneError: gl.getError(),
      sourceError: source.getError(), width: scene.width, height: scene.height});
    return;
  }
  if (data.kind === 'readback') {
    readback = data.enabled;
    postMessage({kind: 'readback', enabled: readback});
    return;
  }
  const {scene, cursor} = data;
  const options = {antialias: false, premultipliedAlpha: false,
    preserveDrawingBuffer: true, depth: true, stencil: true};
  const gl = scene.getContext('webgl2', options);
  const source = new OffscreenCanvas(64, 64).getContext('webgl2');
  const pointer = cursor.getContext('2d');
  if (!gl || !source || !pointer) {
    postMessage({kind: 'error', message: 'WebGL2/2D unavailable'});
    return;
  }
  scene.width = 1088;
  scene.height = 612;
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1088, 612, 0,
    gl.RGBA, gl.UNSIGNED_BYTE, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    postMessage({kind: 'error', message: 'Incomplete framebuffer'});
    return;
  }
  gl.clearColor(1, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  source.clearColor(0, 0, 1, 1);
  pointer.fillStyle = '#00ff00';
  pointer.fillRect(0, 0, 16, 16);
  const bytes = new Uint8Array(64 * 64 * 4);
  function paint() {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, 1088, 612, 0, 612, 1088, 0,
      gl.COLOR_BUFFER_BIT, gl.NEAREST);
    if (readback) {
      source.clear(source.COLOR_BUFFER_BIT);
      source.readPixels(0, 0, 64, 64, source.RGBA, source.UNSIGNED_BYTE, bytes);
    }
    gl.flush();
  }
  paint();
  if (gl.getError() !== gl.NO_ERROR) {
    postMessage({kind: 'error', message: 'Initial GL error'});
    return;
  }
  // Both visible contexts and the native readback source have a live owner.
  globalThis.planes = {scene, cursor, gl, source, pointer, framebuffer, texture};
  setInterval(paint, 16);
  postMessage({kind: 'ready', attributes: gl.getContextAttributes()});
};
