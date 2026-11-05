import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
const fixture=createRequire(import.meta.url)('./fixtures/node-digests-platform.cjs');
const target=createRequire(import.meta.url)('../../packages/registry/node-compat/target.json');
function outcome(fn:()=>unknown) {
  try { return {value:fn()}; }
  catch(e:any) {return {name:e.name,code:e.code,message:e.message,library:e.library,reason:e.reason,opensslErrorStack:e.opensslErrorStack};}
}
describe.skipIf(process.versions.node!==target.version)('one-shot digests and native byte comparison',()=>{
  it('preserves full UTF-8, NUL and view spans across digest encodings and provider aliases',()=>{
    const candidate=fixture.create();
    const backing=Buffer.from([0,0,1,2,3,0]);
    for(const algorithm of ['sha256','SHA256','RSA-SHA256','sha384','sha3-256','blake2b512'])
      for(const input of ['', 'a\0b😀\ud800',backing.subarray(1,5),new DataView(backing.buffer,backing.byteOffset+2,3),new Uint16Array([1,256])])
        for(const encoding of ['hex','buffer','base64url','latin1','utf16le'])
          expect(candidate.hash(algorithm,input,encoding)).toEqual(crypto.hash(algorithm,input,encoding));
  });
  it('owns SHAKE output length, default encoding and non-XOF length errors',()=>{
    const candidate=fixture.create();
    for(const length of [0,1,16,32,129]) for(const algorithm of ['shake128','shake256'])
      expect(candidate.hash(algorithm,'abc',{outputLength:length,outputEncoding:'buffer'}))
        .toEqual(crypto.hash(algorithm,'abc',{outputLength:length,outputEncoding:'buffer'}));
    expect(candidate.hash('sha256','abc')).toBe(crypto.hash('sha256','abc'));
    for(const length of [0,1,31,32,33])
      expect(outcome(()=>candidate.hash('sha256','abc',{outputLength:length}))).toEqual(outcome(()=>crypto.hash('sha256','abc',{outputLength:length})));
  });
  it('retains input/options/encoding validation and backend failure diagnostics',()=>{
    const candidate=fixture.create();
    for(const algorithm of [null,1,{},'no-such-digest'])
      expect(outcome(()=>candidate.hash(algorithm,'x'))).toEqual(outcome(()=>crypto.hash(algorithm as any,'x')));
    for(const input of [null,{},[],new ArrayBuffer(1),new SharedArrayBuffer(1)])
      expect(outcome(()=>candidate.hash('sha256',input))).toEqual(outcome(()=>crypto.hash('sha256',input as any)));
    for(const options of [null,1,{},'bad',{outputEncoding:1},{outputLength:-1},{outputLength:NaN},
      {functionName:'x'},{customization:'x'},{functionName:'\0'}])
      expect(outcome(()=>candidate.hash('sha256','abc',options))).toEqual(outcome(()=>crypto.hash('sha256','abc',options as any)));
  });
  it('derives a fresh deduplicated algorithm list from the real selected provider',()=>{
    const candidate=fixture.create();const names=candidate.getHashes();
    expect(names).toContain('sha256');expect(names).toContain('sha384');
    expect(new Set(names.map((x:string)=>x.toLowerCase())).size).toBe(names.length);
    expect(names).toEqual([...names].sort());names.length=0;expect(candidate.getHashes()).toContain('sha256');
  });
  it('compares actual buffer sources and exact subviews without string/array coercion',()=>{
    const candidate=fixture.create();
    const shared=new SharedArrayBuffer(4);new Uint8Array(shared).set([1,2,3,4]);
    const foreign=runInNewContext('new Uint8Array([1,2,3,4])');
    for(const [a,b] of [[Buffer.from([1,2,3,4]),shared],[foreign,new Uint8Array(shared)],
      [new ArrayBuffer(0),Buffer.alloc(0)],[Buffer.from([1]),Buffer.from([2])],
      [new DataView(new Uint8Array([0,1,2,0]).buffer,1,2),new Uint8Array([1,2])],
      [new Uint8Array([1]),new Uint8Array(0)]])
      expect(outcome(()=>candidate.timingSafeEqual(a,b))).toEqual(outcome(()=>crypto.timingSafeEqual(a,b)));
    for(const bad of ['x',[],{},null,undefined]) {
      expect(outcome(()=>candidate.timingSafeEqual(bad,Buffer.alloc(0)))).toEqual(outcome(()=>crypto.timingSafeEqual(bad as any,Buffer.alloc(0))));
      expect(outcome(()=>candidate.timingSafeEqual(Buffer.alloc(0),bad))).toEqual(outcome(()=>crypto.timingSafeEqual(Buffer.alloc(0),bad as any)));
    }
  });
});
