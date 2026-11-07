onmessage = ({ data: { scene, cursor, source, readbackTimings, contextHint } }) => {
  const width = 640, height = 480;
  let gl = null;
  if (source !== "2d") {
    gl = new OffscreenCanvas(width, height).getContext("webgl2");
    if (!gl) throw new Error("WebGL2 unavailable");
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("Incomplete framebuffer");
    gl.clearColor(1, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(17, 19, 1, 1);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }
  const options = contextHint === "will-read-frequently" ? { willReadFrequently: true }
    : contextHint === "desynchronized" ? { desynchronized: true } : undefined;
  const context = options ? scene.getContext("2d", options) : scene.getContext("2d");
  const pointer = options ? cursor.getContext("2d", options) : cursor.getContext("2d");
  if (!context || !pointer) throw new Error("2D context unavailable");
  postMessage({ kind: "contexts", requested2d: options ?? {},
    scene2d: context.getContextAttributes?.() ?? null,
    cursor2d: pointer.getContextAttributes?.() ?? null,
    sourceGl: gl?.getContextAttributes() ?? null });
  pointer.fillStyle = "#00ff00";
  pointer.fillRect(30, 40, 10, 10);
  // Keep both transferred planes and their contexts alive for the complete
  // capture sequence; collection of an unused cursor must not be a variable.
  globalThis.capturePlanes = { scene, cursor, context, pointer, gl };
  const pixels = new Uint8Array(width * height * 4);
  if (!gl) {
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255;
      pixels[i + 3] = 255;
    }
    pixels.set([255, 255, 255, 255], (19 * width + 17) * 4);
  }
  let sequence = 0;
  function paint() {
    const start = readbackTimings ? performance.now() : 0;
    let readPixelsDone = start;
    if (gl) {
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (readbackTimings) readPixelsDone = performance.now();
      if (gl.getError() !== gl.NO_ERROR) throw new Error("Readback failed");
    }
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
    if (readbackTimings) {
      postMessage({ kind: "readback", sequence: ++sequence, start,
        readPixelsMs: readPixelsDone - start, paintMs: performance.now() - start });
    }
  }
  paint();
  postMessage("ready");
  if (source !== "once") setInterval(paint, 16);
};
