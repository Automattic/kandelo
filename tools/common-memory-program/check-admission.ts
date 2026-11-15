import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {describeWasmArtifactPolicyFailures,readWasmCustomSectionPayload} from '../../host/src/constants';
const bytes=(path:string)=>{const b=readFileSync(path);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
const native=bytes('local-binaries/source-only-v1/programs/wasm32/php/php.wasm');
const virtual=bytes(process.argv[2]);
assert.deepEqual(describeWasmArtifactPolicyFailures(native),[]);
const failures=describeWasmArtifactPolicyFailures(virtual);
assert.deepEqual(failures,['requires the opt-in common-memory prototype host']);
assert.deepEqual(describeWasmArtifactPolicyFailures(virtual,{experimentalCommonMemory:'prototype-v1'}),[]);
assert.ok(describeWasmArtifactPolicyFailures(virtual,{experimentalCommonMemory:'prototype-v1',expectedAbi:999999})
  .some(s=>s.includes('expected 999999')),'opt-in must retain ordinary ABI refusal');
const leb=(value:number)=>{const out=[];do{let byte=value&127;value=Math.floor(value/128);if(value)byte|=128;out.push(byte);}while(value);return out;};
const name=new TextEncoder().encode('kandelo.common-memory.prototype');
const payload=readWasmCustomSectionPayload(virtual,'kandelo.common-memory.prototype')!;
const section=new Uint8Array([0,...leb(leb(name.length).length+name.length+payload.length),...leb(name.length),...name,...payload]);
const append=(base:ArrayBuffer)=>{const out=new Uint8Array(base.byteLength+section.length);out.set(new Uint8Array(base));out.set(section,base.byteLength);return out.buffer;};
assert.ok(describeWasmArtifactPolicyFailures(append(virtual),{experimentalCommonMemory:'prototype-v1'})
  .includes('duplicate common-memory prototype contracts'));
assert.ok(describeWasmArtifactPolicyFailures(append(native),{experimentalCommonMemory:'prototype-v1'})
  .some(s=>s.includes('missing common-memory bindings')));
console.log('ordinary artifact accepted; virtual artifact refused by default; explicit prototype admission retains ABI checks');
