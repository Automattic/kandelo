import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire('/Users/brandon/kandelo-abi44-reconcile/apps/browser-demos/');
const { chromium, webkit } = require('playwright');

const p1 = Array.from(new Uint8Array(await readFile(new URL('p1.wasm', import.meta.url))));
const p2 = Array.from(new Uint8Array(await readFile(new URL('p2.wasm', import.meta.url))));

// Inlined so no server or fetch is needed: bytes are handed to the page directly.
const body = async ({ p1, p2 }) => {
  const out = {};
  const rec = (k, v) => { out[k] = v; };
  const bytes = (a) => new Uint8Array(a);
  try {
    const m = (await WebAssembly.instantiate(bytes(p1), {})).instance.exports;
    rec('P1.d_base', m.d_base()); rec('P1.d_derived', m.d_derived());
    rec('P1.d_other', m.d_other()); rec('P1.d_arri32', m.d_arri32());
    rec('P1.d_arrf64', m.d_arrf64()); rec('P1.d_arrref', m.d_arrref());
    rec('P1.twin_is_base', m.twin_is_base());
    rec('P1.arr_len', m.roundtrip_arr_len());
    rec('P1.struct_field', m.roundtrip_struct_field());
  } catch (e) { rec('P1.ERROR', String((e && e.message) || e)); }
  try {
    const m = (await WebAssembly.instantiate(bytes(p2), {})).instance.exports;
    rec('P2a.inwasm_roundtrip', m.p2a());
    const h = m.make();
    rec('P2b.host_roundtrip_identity', m.check(h));
    rec('P2b.host_roundtrip_type', m.check_type(h));
    const jar = new Map([['k', h]]);
    rec('P2b.after_container', m.check(jar.get('k')));
    rec('P2c.host_externref_is_eq', m.check_host_externref_is_eq({ plain: 'js object' }));
  } catch (e) { rec('P2.ERROR', String((e && e.message) || e)); }
  return out;
};

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await type.launch();
  try {
    const page = await browser.newPage();
    const version = browser.version();
    const results = await page.evaluate(body, { p1, p2 });
    console.log(JSON.stringify({ engine: `${name} ${version}`, results }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ engine: name, fatal: String((e && e.message) || e) }, null, 2));
  } finally { await browser.close(); }
}
