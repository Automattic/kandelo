'use strict';
const assert=require('node:assert/strict'),util=require('node:util');
const native=require('node:net');
const scenario=process.argv[2],mode=process.argv[3];
const peers={exact:['127.0.0.1','::ffff:127.0.0.1','::127.0.0.1','2001:db8::1','127.0.0.2'],
 ranges:['192.0.2.1','192.0.2.2','::ffff:192.0.2.7','192.0.2.9','2001:db8::8','198.51.100.5','::ffff:198.51.100.9','203.0.113.3'],
 subnets:['10.1.1.1','::ffff:10.1.1.1','192.0.2.5','::ffff:192.0.2.5','2001:db8::1','198.51.100.1']};
function addr(Type,address,port=0){return new Type.SocketAddress({address,port,family:address.includes(':')?'ipv6':'ipv4'});}
function snapshot(b,addresses){return{size:b.size,rules:b.rules,checks:addresses.map(a=>b.check(a,a.includes(':')?'ipv6':'ipv4'))};}
function outcome(fn){try{return{value:fn()};}catch(e){return{name:e.name,code:e.code,message:e.message};}}
function run(Type){
 const b=new Type.BlockList();
 if(scenario==='addresses')return[
  ['ipv4','127.0.0.1'],['ipv4','01.2.3.4'],['ipv4','1.2.3.256'],['ipv4','127.0.0.1\0ignored'],
  ['ipv6','::'],['ipv6','::1'],['ipv6','::2'],['ipv6','::ffff:192.0.2.1'],
  ['ipv6','2001:0DB8:0:1:0:1:0:1'],['ipv6','fe80::1%lo'],['ipv6','bad'],
 ].map(([family,address])=>{try{return new Type.SocketAddress({family,address,port:123}).toJSON();}catch(e){assert.equal(e.code,'ERR_INVALID_ADDRESS');return null;}});
 if(scenario==='exact'){
  b.addAddress(addr(Type,'127.0.0.1',33));b.addAddress('2001:db8::1','ipv6');const steps=[snapshot(b,peers.exact)];
  b.addAddress(addr(Type,'::ffff:127.0.0.1',99));steps.push(snapshot(b,peers.exact));
  b.removeAddress('127.0.0.1');steps.push(snapshot(b,peers.exact));
  b.addAddresses([addr(Type,'127.0.0.2'),addr(Type,'2001:db8::2'),addr(Type,'127.0.0.2')]);steps.push(snapshot(b,peers.exact));
  b.clear();steps.push(snapshot(b,peers.exact));return steps;
 }
 if(scenario==='ranges'){
  function add(start,end){try{b.addRange(addr(Type,start),addr(Type,end));return true;}catch(e){assert.equal(e.code,'ERR_INVALID_ARG_VALUE');return false;}}
  const added=[add('192.0.2.2','192.0.2.8'),add('192.0.2.8','192.0.2.2'),add('2001:db8::2','2001:db8::8'),add('198.51.100.2','::ffff:198.51.100.8'),add('203.0.113.1','2001:db8:1::1')];
  const steps=[snapshot(b,peers.ranges)];
  b.removeRange(addr(Type,'192.0.2.2',1),addr(Type,'192.0.2.8'));steps.push(snapshot(b,peers.ranges));
  b.removeRange('192.0.2.2','192.0.2.8');steps.push(snapshot(b,peers.ranges));return{added,snapshots:steps};
 }
 if(scenario==='subnets'){
  b.addSubnet('10.1.2.3',8);b.addSubnet('::ffff:192.0.2.99',120,'ipv6');b.addSubnet('2001:db8::5',32,'ipv6');
  const steps=[snapshot(b,peers.subnets)];b.addSubnet('::',0,'ipv6');steps.push(snapshot(b,peers.subnets));
  b.removeSubnet('::',0,'ipv6');steps.push(snapshot(b,peers.subnets));
  b.addSubnet('10.1.2.3',8);b.removeSubnet(addr(Type,'10.1.2.3',5),8);steps.push(snapshot(b,peers.subnets));
  b.removeSubnet('10.1.2.3',8);steps.push(snapshot(b,peers.subnets));b.removeSubnet('10.1.2.3',8);steps.push(snapshot(b,peers.subnets));return steps;
 }
 if(scenario==='concurrency'){
  // Native Node's single-thread reference supplies final set semantics. The
  // separately compiled portable owner exercises actual shared-state threads.
  let checked=0;for(let t=0;t<4;t++)for(let i=0;i<32;i++){const a=`192.0.${t}.${i}`;b.addAddress(a);if(b.check(a))checked++;}
  return{size:b.size,checked,retainedOwnerWorks:b.check('192.0.3.31')};
 }
 if(scenario==='public'){
  const steps=[];
  for(const args of [[],[{}],[{family:'ipv6'}],[{address:'::ffff:192.0.2.1',family:'ipv6',port:'12'}],
   [{family:'IPv4'}],[null],[{address:'bad'}],[{port:-1}],[{flowlabel:-1}],
   [{address:'::1',family:'ipv6',flowlabel:1048575}]])steps.push(outcome(()=>new Type.SocketAddress(...args).toJSON()));
  for(const input of ['127.1:80','127.0.0.1:8080','[::1]:443','[::ffff:192.0.2.1]:9','0x7f000001:81','example.org:9','invalid',1]){
   steps.push(outcome(()=>Type.SocketAddress.parse(input)?.toJSON()));
  }
  steps.push(Object.isFrozen(Type.BlockList.PRIVATE_RANGES),Type.BlockList.PRIVATE_RANGES);
  steps.push(outcome(()=>b.addAddresses(['127.0.0.1','bad'])),snapshot(b,peers.exact));
  b.addCIDRs(['10.0.0.0/8','2001:db8::/32']);steps.push(b.rules);
  steps.push(outcome(()=>b.addCIDRs(['192.0.2.0/24','2001:db8::/129'])),b.rules);
  b.fromJSON(['Address: IPv4 127.0.0.1','Range: IPv6 2001:db8::1-2001:db8::9']);
  steps.push(b.toJSON(),b.size,b.check('2001:db8::2','nonsense-family'),util.inspect(b));
  b.removeCIDR('10.0.0.0/8');steps.push(b.rules);
  steps.push(outcome(()=>b.addRange('127.0.0.2','127.0.0.1')));
  steps.push(outcome(()=>b.fromJSON('[1]')),outcome(()=>b.addCIDR('127.0.0.1/01')));
  for(const key of ['addAddress','addAddresses','addRange','addSubnet','removeAddress','removeRange','removeSubnet','clear','fromJSON','toJSON']){
   const d=Object.getOwnPropertyDescriptor(Type.BlockList.prototype,key);
   steps.push([key,d.enumerable,d.configurable,d.writable,d.value.name,d.value.length]);
  }
  return steps;
 }
 throw Error('Unknown scenario');
}
if(mode==='owner'){
 const helper=process.env.KANDELO_ADDRESS_NATIVE_HELPER;
 if(!helper)throw Error('Explicit native helper required');
 const child=require('node:child_process').spawnSync(helper,[scenario],{encoding:'utf8',timeout:10000});
 if(child.error)throw child.error;assert.equal(child.status,0,child.stderr);process.stdout.write(child.stdout);
}else if(mode==='candidate'){
 console.log(JSON.stringify(run(require('./node-address-rules-platform.cjs').create())));
}else if(mode==='native'){
 console.log(JSON.stringify(run(native)));
}else throw Error('Select explicit candidate, native or owner mode');
