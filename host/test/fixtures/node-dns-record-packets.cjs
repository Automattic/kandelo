'use strict';
// Owned loopback DNS peer packet definitions, never candidate-side answers.
const {Buffer}=require('node:buffer');
function u16(n){const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;}
function u32(n){const b=Buffer.alloc(4);b.writeUInt32BE(n>>>0);return b;}
function name(value){return Buffer.concat(value.split('.').filter(Boolean).flatMap(x=>[Buffer.from([Buffer.byteLength(x)]),Buffer.from(x)]).concat(Buffer.from([0])));}
function str(value){const b=Buffer.isBuffer(value)?value:Buffer.from(value,'latin1');return Buffer.concat([Buffer.from([b.length]),b]);}
function body(rr){const v=rr.value;
 switch(rr.type){
 case 1:return Buffer.from(v.split('.').map(Number));
 case 28:{const b=Buffer.alloc(16);v.split(':').forEach((x,i)=>b.writeUInt16BE(parseInt(x||'0',16),i*2));return b;}
 case 2:case 5:case 12:return name(v);
 case 15:return Buffer.concat([u16(v.priority),name(v.exchange)]);
 case 16:return Buffer.concat(v.map(str));
 case 33:return Buffer.concat([u16(v.priority),u16(v.weight),u16(v.port),name(v.name)]);
 case 35:return Buffer.concat([u16(v.order),u16(v.preference),str(v.flags),str(v.service),str(v.regexp),name(v.replacement)]);
 case 6:return Buffer.concat([name(v.nsname),name(v.hostmaster),...['serial','refresh','retry','expire','minttl'].map(k=>u32(v[k]))]);
 case 52:return Buffer.concat([Buffer.from([v.certUsage,v.selector,v.match]),Buffer.from(v.data)]);
 case 257:return Buffer.concat([Buffer.from([v.critical]),str(v.tag),Buffer.from(v.value,'latin1')]);
 default:return Buffer.from(v??[]);
 }
}
const a={type:1,ttl:47,value:'203.0.113.77'},aaaa={type:28,ttl:63,value:'2001:db8:0:0:0:0:0:7'};
const mx={type:15,ttl:40,value:{priority:10,exchange:'mail.records.test'}};
const soa={type:6,ttl:41,value:{nsname:'ns.records.test',hostmaster:'admin.records.test',serial:0xffffffff,refresh:0x80000001,retry:23,expire:71,minttl:0xfedcba98}};
const txt={type:16,ttl:42,value:[Buffer.from([0xff,0,65]),'','hello']};
const srv={type:33,ttl:43,value:{priority:5,weight:11,port:443,name:'service.records.test'}};
const naptr={type:35,ttl:44,value:{order:1,preference:2,flags:'s',service:'SIP+D2U',regexp:'!^.*$!sip:info@example.test!',replacement:'replacement.records.test'}};
const tlsa={type:52,ttl:45,value:{certUsage:3,selector:1,match:1,data:[0,255,1,2]}};
const caa={type:257,ttl:46,value:{critical:128,tag:'issue',value:'authority.test\0tail\xff'}};
exports.cases=[
 {id:'nxdomain',method:'queryA',type:1,rcode:3,records:[]},
 {id:'no-data',method:'queryA',type:1,records:[]},
 {id:'server-failure',method:'queryA',type:1,rcode:2,records:[]},
 {id:'a',method:'queryA',type:1,records:[a,{...a,ttl:91,value:'198.51.100.29'}]},
 {id:'aaaa',method:'queryAaaa',type:28,records:[aaaa]},
 {id:'cname',method:'queryCname',type:5,records:[{type:5,ttl:30,value:'canonical.records.test'}]},
 {id:'mx',method:'queryMx',type:15,records:[mx]}, {id:'ns',method:'queryNs',type:2,records:[{type:2,ttl:31,value:'ns.records.test'}]},
 {id:'ptr',method:'queryPtr',type:12,records:[{type:12,ttl:32,value:'ptr.records.test'}]},
 {id:'txt',method:'queryTxt',type:16,records:[txt,{type:16,ttl:40,value:['last']}]},
 {id:'srv',method:'querySrv',type:33,records:[srv]}, {id:'naptr',method:'queryNaptr',type:35,records:[naptr]},
 {id:'soa',method:'querySoa',type:6,records:[soa]}, {id:'tlsa',method:'queryTlsa',type:52,records:[tlsa]},
 {id:'caa',method:'queryCaa',type:257,records:[caa]},
 {id:'any',method:'queryAny',type:255,records:[a,aaaa,mx,txt,srv,{type:2,ttl:31,value:'ns.records.test'},{type:12,ttl:32,value:'ptr.records.test'},naptr,soa,tlsa,caa]},
 {id:'any-cname',method:'queryAny',type:255,records:[{type:5,ttl:12,value:'canonical.records.test'},{...a,name:'canonical.records.test'}]},
 {id:'tlsa-mixed',method:'queryTlsa',type:52,records:[{type:5,ttl:12,value:'canonical.records.test'},{...tlsa,name:'canonical.records.test'}]},
 {id:'tlsa-empty',method:'queryTlsa',type:52,records:[{...tlsa,value:{...tlsa.value,data:[]}}]},
 {id:'txt-empty',method:'queryTxt',type:16,records:[{type:16,ttl:1,value:['']}]},
 {id:'caa-collision',method:'queryCaa',type:257,records:[{...caa,value:{critical:1,tag:'critical',value:'override'}}]},
 {id:'caa-proto',method:'queryCaa',type:257,records:[{...caa,value:{critical:1,tag:'__proto__',value:'ignored'}}]},
];
exports.packet=function packet(query,scenario){let end=12;while(query[end])end+=query[end]+1;end+=5;
 const question=query.subarray(12,end),header=Buffer.alloc(12);query.copy(header,0,0,2);header.writeUInt16BE(0x8180 | (scenario.rcode??0),2);header.writeUInt16BE(1,4);header.writeUInt16BE(scenario.records.length,6);
 const qname=scenario.id+'.records.test';const answers=scenario.records.map(rr=>{const data=body(rr);return Buffer.concat([name(rr.name??qname),u16(rr.type),u16(1),u32(rr.ttl??0),u16(data.length),data]);});
 return Buffer.concat([header,question,...answers]);
};
exports.questionName=function questionName(packet){let i=12,parts=[];while(packet[i]){const n=packet[i++];parts.push(packet.subarray(i,i+n).toString());i+=n;}return parts.join('.');};
