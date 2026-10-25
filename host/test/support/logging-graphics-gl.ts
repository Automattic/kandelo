import { foreignTextureGl } from "./foreign-texture-gl";

/** Stateful allocation/ownership double; pixels are verified in browsers. */
export function loggingGraphicsGl() {
  const calls: [string, unknown[]][] = [];
  const native = foreignTextureGl();
  const compiled = new Set<unknown>(), linked = new Set<unknown>();
  const attached = new Map<unknown, Set<unknown>>();
  const gl = new Proxy(native.gl, {
    get(target, key) {
      if (typeof key !== "string") return Reflect.get(target, key);
      const member = Reflect.get(target, key);
      if (typeof member !== "function" && member !== undefined) return member;
      if (/^[A-Z0-9_]+$/.test(key)) return undefined;
      return (...args: unknown[]) => {
        calls.push([key, args.map(value => ArrayBuffer.isView(value)
          ? Array.from(value as unknown as ArrayLike<number>) : value)]);
        if (typeof member === "function") return Reflect.apply(member, target, args);
        if (key === "compileShader") { compiled.add(args[0]); return; }
        if (key === "attachShader") {
          let shaders = attached.get(args[0]);
          if (!shaders) attached.set(args[0], shaders = new Set());
          shaders.add(args[1]); return;
        }
        if (key === "linkProgram") {
          const shaders = [...(attached.get(args[0]) ?? [])];
          if (shaders.length >= 2 && shaders.every(shader => compiled.has(shader))) linked.add(args[0]);
          return;
        }
        if (key === "getShaderParameter" && args[1] === 0x8b81) return compiled.has(args[0]);
        if (key === "getProgramParameter" && args[1] === 0x8b82) return linked.has(args[0]);
        if (key.startsWith("create") || key === "getUniformLocation") return {};
        if (key.startsWith("get")) return 0;
      };
    },
  });
  return { gl, calls, native };
}

/** Find a texture by its allocated storage, without depending on undefined
 * native constants or implementation-specific framebuffer call ordering. */
export function allocatedTexture(calls: [string, unknown[]][], width: number, height: number) {
  let bound: unknown;
  for (const [name, args] of calls) {
    if (name === "bindTexture" && args[0] === 0x0de1) bound = args[1];
    if (name === "texImage2D" && args[3] === width && args[4] === height) return bound;
  }
}
