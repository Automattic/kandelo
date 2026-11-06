// A standalone Wasm check, with no Kandelo memory, imports, or runtime.
const fs = require("node:fs");
function check() {
  const wasm = fs.readFileSync(process.argv[2]);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm));
  const count = Number(process.argv[3]);
  for (let state = 0; state < count; state++) {
    for (let ch = 0; ch < 6; ch++) {
      const step = ch === 1 ? 6 : ch === 2 ? 5 : ch === 3 ? 3 : 0;
      const actual = instance.exports.lex(ch, state);
      if (actual !== (state + step) % count) {
        throw new Error(`state=${state}, input=${ch}: ${actual}`);
      }
    }
  }
  console.log(`verified ${count * 6} state/input combinations`);
}
try { check(); } catch (error) { console.error(error); process.exit(1); }
