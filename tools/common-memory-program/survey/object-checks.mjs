import {ProgramGroup,PAGE} from '../runtime.mjs';
const must=(ok,message)=>{if(!ok)throw Error(message);};
const trap=fn=>{try{fn();}catch(e){if(e instanceof WebAssembly.RuntimeError)return;throw e;}throw Error('missing original trap');};
export function runObjectRegions(module,helperModule) {
 const group=new ProgramGroup({initialPages:128,maximumPages:128,scratchBytes:PAGE});
 const a=group.create(module),e=a.exports;
 const helper=new WebAssembly.Instance(helperModule,{env:{memory:group.memory}}).exports;
 const guard=(p,n,rights=3,root=a.root)=>helper.vm_try_span(p,n,rights,root);
 const put=(ctx,p,v)=>group.write(ctx,p,new Uint8Array(new Uint32Array([v]).buffer));
 const get=(ctx,p)=>new DataView(group.read(ctx,p,4).buffer).getUint32(0,true);
 const metadata=group.metadata(module),proof=metadata.guardedObjects;
 if(proof)must(proof.selectedFunctions===7&&proof.functions.every((p,i)=>p.function===i), 'proof selected a rejection control');
 put(a,136,7);must(guard(128,12)!==0,'contiguous guard miss');
 must(e.fields(128,17)===24&&get(a,132)===128,'field result/canonical stored pointer');
 must(e.narrow(256,65535)===65534,'signed/unsigned narrow values');
 must(e.tee_alias(384,41)===384&&get(a,388)===384,'tee preserves canonical pointer');
 put(a,0,3);put(a,4,5);must(e.zero_local()===8,'unchanged zero-initialized base');
 const first=group.table(a)[0]&-PAGE,second=group.table(a)[1]&-PAGE,cross=PAGE-4;
 group.map(a,0,first,{rights:2});must(guard(512,12,2)!==0&&guard(512,8,1)===0,'write-only guard rights');
 e.late_fault(512,90);trap(()=>e.read_only(512));group.map(a,0,first);
 must(get(a,512)===90&&get(a,520)===91,'write-only fast stores');
 put(a,cross+8,9);must(guard(cross,12)!==0,'contiguous cross-page guard miss');
 must(e.fields(cross,31)===40&&get(a,cross+4)===cross,'cross-page fast region');
 group.map(a,PAGE,second,{rights:1});must(guard(cross,12)===0,'permission guard must miss');
 trap(()=>e.late_fault(cross,80));must(get(a,cross)===80&&get(a,cross+8)===9,'guard hoisted fault before earlier store');
 group.table(a)[1]=0;must(guard(cross,12)===0,'hole guard must miss');
 trap(()=>e.late_fault(cross,81));must(get(a,cross)===81,'hole lost earlier visible store');
 // A pure division trap must still precede every payload write on a miss.
 trap(()=>e.arithmetic_trap(cross,99));must(get(a,cross)===81,'arithmetic trap reordered stores');
 const scattered=group.alloc(1);group.map(a,PAGE,scattered);
 must(guard(cross,12)===0,'scatter guard must miss');put(a,cross+8,11);
 must(e.fields(cross,33)===44&&get(a,cross+4)===cross,'scatter slow region');
 group.map(a,PAGE,first);must(guard(cross,12)===0,'aliased pages are not contiguous');
 put(a,cross+8,11);must(e.fields(cross,35)===46&&get(a,cross+4)===cross,'aliased page slow region');
 group.map(a,0,first,{rights:1});must(guard(128,8,1)!==0&&guard(128,12)===0,'union rights guard');
 must(e.read_only(128)===145,'read-only object fields');trap(()=>e.fields(128,111));must(get(a,128)===17,'denied object store changed data');
 const replacement=group.alloc(1);group.map(a,0,replacement);put(a,136,13);
 must(e.fields(128,40)===53,'remapped base did not rematerialize');
 group.map(a,PAGE,scattered,{shared:true});put(a,PAGE+136,17);e.fields(PAGE+128,51);
 const b=group.create(module,a),be=b.exports;
 must(get(b,132)===128,'copied canonical pointer');must(be.fields(128,70)===83,'child private fields');
 must(get(a,128)===40&&get(b,128)===70,'derived physical base crossed private copy');
 must(be.fields(PAGE+128,61)===78&&get(a,PAGE+128)===61,'shared payload not live');
 must(e.fields(PAGE+128,62)===79&&get(b,PAGE+128)===62,'reverse shared visibility');
 // Sparse endpoint and malformed-metadata guards return zero without trapping.
 const header=new Uint32Array(group.memory.buffer,a.root,5),savedPages=header[0];
 header[0]=1;must(guard(PAGE,8,1)===0,'valid PTE beyond virtual limit accepted');trap(()=>e.read_only(PAGE));
 header[0]=65536;group.table(a)[65535]=replacement|3;
 put(a,0xfffffff8,2);put(a,0xfffffffc,3);must(guard(0xfffffff8,8,1)!==0&&e.read_only(-8)===5,'exact4GiB endpoint');
 must(guard(0xfffffff8,12)===0,'4GiB overflow guard');trap(()=>e.late_fault(-8,91));must(get(a,0xfffffff8)===91,'overflow lost valid prefix store');
 header[0]=0;must(guard(0,8)===0,'zero-page bounds');header[0]=65537;must(guard(0,8)===0,'invalid page count');header[0]=savedPages;
 must(guard(128,0)===0&&guard(128,PAGE+1)===0&&guard(128,8,0)===0,'guard argument bounds');
 must(guard(128,8,3,0)===0&&guard(128,8,3,0xffffffff)===0,'invalid root trapped');
 const old=group.table(a)[0];group.table(a)[0]=128*PAGE|3;must(guard(128,8)===0,'physical endpoint not checked');group.table(a)[0]=old;
 return {passed:true,guarded:!!proof,selectedFunctions:proof?.selectedFunctions??0,maximumReservationBytes:128*PAGE,
  checks:['proof/rejection inventory','canonical pointer values and narrow fields','contiguous one/cross-page fields','permission/hole/overflow prefix-store order',
   'pure arithmetic trap order','scatter/alias fallback','read-only and write-only union rights','remap before reentry','synthetic private copy and live shared payload',
   'exact4GiB and virtual/PTE/physical bounds','nontrapping invalid guard inputs']};
}
