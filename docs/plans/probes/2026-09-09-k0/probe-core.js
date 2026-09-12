// Shared probe body. Runs identically on Node and in a browser.
export async function runProbes(load) {
  const out = {};
  const rec = (k, v) => { out[k] = v; };
  try {
    const p1 = (await WebAssembly.instantiate(await load('p1.wasm'), {})).instance.exports;
    rec('P1.d_base',    p1.d_base());     // expect 1
    rec('P1.d_derived', p1.d_derived());  // expect 2
    rec('P1.d_other',   p1.d_other());    // expect 3
    rec('P1.d_arri32',  p1.d_arri32());   // expect 4
    rec('P1.d_arrf64',  p1.d_arrf64());   // expect 5
    rec('P1.d_arrref',  p1.d_arrref());   // expect 6
    rec('P1.twin_is_base', p1.twin_is_base());          // expect 1 (canonicalization)
    rec('P1.arr_len', p1.roundtrip_arr_len());          // expect 5
    rec('P1.struct_field', p1.roundtrip_struct_field()); // expect 20
  } catch (e) { rec('P1.ERROR', String(e && e.message || e)); }
  try {
    const p2 = (await WebAssembly.instantiate(await load('p2.wasm'), {})).instance.exports;
    rec('P2a.inwasm_roundtrip', p2.p2a());  // expect 1
    const handle = p2.make();               // externref derived from a GC object
    rec('P2b.host_roundtrip_identity', p2.check(handle));  // expect 1
    rec('P2b.host_roundtrip_type',     p2.check_type(handle)); // expect 1
    // Prove the host really holds it as an opaque JS value across a container.
    const jar = new Map([['k', handle]]);
    rec('P2b.after_container', p2.check(jar.get('k')));    // expect 1
    // CONTROL: a genuine host externref.
    rec('P2c.host_externref_is_eq', p2.check_host_externref_is_eq({ plain: 'js object' })); // expect 0
  } catch (e) { rec('P2.ERROR', String(e && e.message || e)); }
  return out;
}
