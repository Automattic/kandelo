// Receives the transferred bytes and compiles them, exactly as
// `browser-kernel-worker-entry.ts` does at its dylinkModuleBytes branch.
self.onmessage = async (e) => {
  const out = { received: false };
  try {
    const bytes = e.data.dylinkModuleBytes;
    out.received = bytes instanceof ArrayBuffer;
    out.byteLength = bytes?.byteLength ?? null;
    const module = await WebAssembly.compile(bytes);
    out.compiled = true;
    out.imports = WebAssembly.Module.imports(module).length;
    out.dlExports = WebAssembly.Module.exports(module)
      .filter((x) => x.name.startsWith('dl_')).length;
  } catch (err) {
    out.error = `${err?.name}: ${String(err?.message).slice(0, 140)}`;
  }
  self.postMessage(out);
};
