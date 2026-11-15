"""Bounded real-Wasm positive/negative tests of call-effect feasibility."""
from pathlib import Path
import subprocess,sys,json,hashlib
out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=False)
host=subprocess.check_output(['rustc','-vV'],text=True).split('host: ')[1].splitlines()[0]
tool=Path(sys.argv[2]).resolve() if len(sys.argv)>2 else (Path('tools/common-memory-program/feasibility/target')/host/'debug/calls').resolve()
parts=['''(module
(type $void (func))
(import "env" "memory" (memory 2 16 shared))
(import "env" "remap" (func $remap))
(import "kernel" "kernel_fork" (func $fork (result i32)))
(table 1 funcref)
(global $counter (mut i32) (i32.const 0))
(tag $failure (param i32))
(func $eh_control (export "eh_control") (param i32) (result i32)
 block $caught (result i32)
  try_table (result i32) (catch $failure $caught)
   local.get 0 i32.load
  end
 end)
(func $thrower (export "thrower") (param i32) (result i32) local.get 0 throw $failure)
(func $catch_throw (export "catch_throw") (param i32) (result i32)
 block $caught (result i32)
  try_table (result i32) (catch $failure $caught)
   local.get 0 call $thrower
  end
 end)
(func $noop (export "noop")) (export "__vm_wait" (func $noop)) (export "__vm_lock" (func $noop)) (export "__vm_unlock" (func $noop)) (elem (i32.const 0) $noop)
(func $reader (export "reader") (param i32) (result i32) local.get 0 i32.load)
(func $reader2 (export "reader2") (param i32) (result i32) local.get 0 call $reader)
(func $writer (export "writer") (param i32) (result i32) local.get 0 i32.const 1 i32.store local.get 0 i32.load)
(func $copy (export "copy") (param i32 i32) local.get 0 local.get 1 i32.const 4 memory.copy)
(func $grow (export "grow") i32.const 0 memory.grow drop)
(func $notify (export "notify") (param i32) local.get 0 i32.const 1 memory.atomic.notify drop)
(func $atomic_reader (export "atomic_reader") (param i32) (result i32) local.get 0 i32.atomic.load)
(func $via_import (export "via_import") call $remap)
(func $via_fork (export "via_fork") call $fork drop)
(func $indirect (export "indirect") i32.const 0 call_indirect (type $void))
(func $table_op (export "table_op") i32.const 0 table.get 0 drop)
(func $reference_op (export "reference_op") (result funcref) ref.null func)
(func $tail (export "tail") (param i32) (result i32) local.get 0 return_call $reader2)
(func $a (export "recursive_a") (param i32) (result i32) local.get 0 i32.eqz if (result i32) i32.const 0 else local.get 0 i32.const 1 i32.sub call $b end)
(func $b (export "recursive_b") (param i32) (result i32) local.get 0 call $a)
(func $bad_a (export "bad_a") call $bad_b)
(func $bad_b (export "bad_b") call $remap)
(func $wide (export "wide") (param f64) (result f64) local.get 0)
(func $touch_global (export "touch_global") global.get $counter i32.const 1 i32.add global.set $counter)
''']
loads=' '.join('local.get 0 i32.load offset='+str(i*4)+' drop' for i in range(4))
for name,middle in [('parent_safe','local.get 0 call $reader2 drop'),('parent_writer','local.get 0 call $writer drop'),('parent_import','call $via_import'),('parent_notify','local.get 0 call $notify'),('parent_grow','call $grow'),('parent_global','call $touch_global'),('parent_change_base','local.get 0 call $reader2 local.set 0')]:
 parts.append(f'(func (export "{name}") (param i32) {loads} {middle} {loads})')
parts.append(')');wat=out/'fixture.wat';wat.write_text('\n'.join(parts)+'\n');wasm=out/'fixture.wasm';subprocess.run(['wat2wasm','--enable-threads','--enable-tail-call','--enable-exceptions',str(wat),'-o',str(wasm)],check=True)
r=subprocess.run([str(tool),str(wasm),str(out/'report.json')],capture_output=True,text=True);(out/'tool.log').write_text(r.stdout+r.stderr);r.check_returncode();report=json.loads((out/'report.json').read_text());checks=0
names={name:f['function']for f in report['readOnlyCalls']['callEffects']['functions']for name in f['exports']}
def check(value,label):
 global checks
 assert value,label;checks+=1
def facts(policy,name):return report[policy]['callEffects']['functions'][names[name]]
def plans(policy,name):return [r for r in report[policy]['regions']if r['function']==names[name]and r['sites']>=4]
for name in ['reader','reader2','tail','recursive_a','recursive_b','touch_global','eh_control','__vm_wait','__vm_lock','__vm_unlock']:
 check(facts('readOnlyCalls',name)['i32CallEligible'],name+' strict eligible')
for name in ['writer','copy']:
 check(facts('readOnlyCalls',name)['excluded'],name+' strict write exclusion');check(facts('writeAllowingOpportunity',name)['i32CallEligible'],name+' opportunity only')
for name in ['grow','notify','atomic_reader','via_import','via_fork','indirect','table_op','reference_op','bad_a','bad_b','thrower','catch_throw']:
 for policy in ['readOnlyCalls','writeAllowingOpportunity']:check(facts(policy,name)['excluded'],name+' exclusion '+policy)
check(not facts('readOnlyCalls','wide')['excluded']and not facts('readOnlyCalls','wide')['i32CallEligible'],'non-i32 signature is not a regional call')
check(facts('readOnlyCalls','bad_a')['witnessCallee']==names['bad_b'],'transitive witness')
for name in ['parent_safe','parent_global']:
 check(len(plans('baseline',name))==2,name+' baseline barriers');p=plans('readOnlyCalls',name);check(len(p)==1 and p[0]['sites']==8 and len(p[0]['directCalls'])==1,name+' strict merged region')
check(len(plans('readOnlyCalls','parent_writer'))==2,'unknown store destination stays a strict barrier')
check(len(plans('writeAllowingOpportunity','parent_writer'))==1,'write-allowing opportunity estimate')
for name in ['parent_import','parent_notify','parent_grow','parent_change_base']:
 check(len(plans('readOnlyCalls',name))==2 and not any(p['directCalls']for p in plans('readOnlyCalls',name)),name+' preserves barriers/base proof')
(out/'checks.json').write_text(json.dumps({'passed':True,'checks':checks,'scope':'Real Wasm parse/validation, transitive effects/signatures and strict-vs-opportunity region selection. No Wasm rewrite or performance claim.','inputSha256':hashlib.sha256(wasm.read_bytes()).hexdigest()},indent=2)+'\n');print('call-effects real-Wasm checks:',checks,'passed')
# Original Wasm globals cannot name the translator's appended root/config.
# Refuse already translated inputs rather than silently treating root switches
# as harmless source-global updates.
reserved=out/'reserved.wat';reserved.write_text('(module (import "env" "memory" (memory 2 16 shared)) (global (export "__vm_root") (mut i32) (i32.const 0)))\n');subprocess.run(['wat2wasm','--enable-threads',str(reserved),'-o',str(out/'reserved.wasm')],check=True)
def leb(n):
 b=bytearray()
 while True:
  byte=n&127;n>>=7;b.append(byte|(128 if n else 0))
  if not n:return bytes(b)
marker=b'kandelo.common-memory.prototype';payload=leb(len(marker))+marker+b'{}';marked=out/'marked.wasm';marked.write_bytes(wasm.read_bytes()+b'\0'+leb(len(payload))+payload)
for name in ['reserved','marked']:
 target=out/(name+'-rejected.json');r=subprocess.run([str(tool),str(out/(name+'.wasm')),str(target)],capture_output=True,text=True);(out/(name+'-rejected.log')).write_text(r.stdout+r.stderr);check(r.returncode!=0 and 'untranslated source' in r.stderr and not target.exists(),name+' refuses pretranslated input')
(out/'admission-checks.json').write_text(json.dumps({'passed':True,'positiveChecks':checks-2,'admissionNegatives':2,'totalChecks':checks},indent=2)+'\n');print('call-effects source admission:2negative checks passed; total',checks)
