const contexts = new WeakMap<HTMLCanvasElement | OffscreenCanvas, WebGL2RenderingContext>();

export function getCanvasWebGl2Context(canvas: HTMLCanvasElement | OffscreenCanvas): WebGL2RenderingContext | null {
  const existing = contexts.get(canvas);
  if (existing) return existing;
  const context = canvas.getContext("webgl2", {
    antialias: false,
    premultipliedAlpha: false,
    depth: true,
    stencil: true,
    preserveDrawingBuffer: true,
  }) as WebGL2RenderingContext | null;
  if (context) contexts.set(canvas, context);
  return context;
}
