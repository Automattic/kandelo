// Mirrors the three sibling branches in `browser-kernel-worker-entry.ts`:
// each side module arrives as transferred bytes and is compiled with
// `await WebAssembly.compile(msg.<name>Bytes)`.
self.onmessage = async (e) => {
  const out = {};
  for (const [name, bytes] of Object.entries(e.data)) {
    const row = { received: bytes instanceof ArrayBuffer, byteLength: bytes?.byteLength ?? null };
    try {
      const module = await WebAssembly.compile(bytes);
      row.compiled = true;
      row.imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
      row.exportCount = WebAssembly.Module.exports(module).length;
    } catch (err) {
      row.error = `${err?.name}: ${String(err?.message).slice(0, 140)}`;
    }
    out[name] = row;
  }
  self.postMessage(out);
};
