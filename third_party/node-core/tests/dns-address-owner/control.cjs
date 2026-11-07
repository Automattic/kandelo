'use strict';
const assert=require('node:assert/strict'),dns=require('node:dns'),fs=require('node:fs'),path=require('node:path');
assert.equal(process.version,'v26.13.0');
const root=path.resolve(__dirname,'../../../..');
const util=require('node:util'),os=require('node:os');
const addon=require(process.env.DNS_ADDRESS_COMPONENT),leases=[];
assert.equal(addon.version(),process.versions.ares);
const core=Function(fs.readFileSync(process.env.DNS_ADDRESS_BUNDLE||path.join(root,'third_party/node-core/node-core.js'),'utf8')+';return {dns:_createNodeDnsLookupPlatform,ip:_createNodeNetworkIP,values:_createNodeValuesPlatform,uv:_createNodeUvPlatform};')();
const uv=core.uv({native:{getUvErrorData:()=>[...util.getSystemErrorMap()].map(([number,[name,message]])=>[number,name,message])}});
const values=core.values({process,uv,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
const web=Function(fs.readFileSync(path.join(root,'third_party/node-web-platform/node-web-platform.js'),'utf8')+';return _createNodeWebPlatform;')()();
const native={
 createDnsChannel(prototype,...options){const lease=addon.open(...options);leases.push(lease);return Object.setPrototypeOf(lease,prototype);},
 dnsGetServers:channel=>addon.servers(channel),dnsSetServers:(channel,servers)=>addon.setServers(channel,servers),
 dnsSetLocalIP:(channel,family,address)=>addon.local(channel,family,address),dnsCancel:channel=>addon.cancel(channel),
 dnsLookupConstants:()=>({AI_ADDRCONFIG:dns.ADDRCONFIG,AI_ALL:dns.ALL,AI_V4MAPPED:dns.V4MAPPED}),
 getAsyncResourceInfo(){throw Error('Guest async-resource bridge is outside this focused configuration component');},
 dnsQuery(){throw Error('Query transport is outside this focused native configuration component');},
 dnsStrError:code=>process.binding('cares_wrap').strerror(code),
};
const subject=core.dns({native,values,Buffer,process,ip:core.ip(),hostnameToASCII:web.hostnameToASCII,
 observation:require('internal/perf/observe'),asyncProviders:require('node:async_hooks').asyncWrapProviders});
const rows=[];
function error(fn){try{return {value:fn()};}catch(e){return {error:{name:e.name,code:e.code,message:e.message}};}}
try{
 for(const [label,api,ref] of [['callback',subject.api,dns],['promise',subject.promises,dns.promises]]){
  const candidate=new api.Resolver({timeout:10,tries:1}),reference=new ref.Resolver({timeout:10,tries:1});
  const inputs=[['::1%scope'],['::1%'],['::1%bad name'],['::1%a%b'],['::ffff:127.0.0.1%any'],['127.0.0.1','::1%zone'],['::1%zone','127.0.0.1'],['::1%scope','bad'],['::1%bad name','::2%scope'],['127.0.0.1%scope'],['bad%scope'],['::1\0%scope']];
  for(const args of inputs){const actual=error(()=>candidate.setLocalAddress(...args)),expected=error(()=>reference.setLocalAddress(...args));rows.push({name:label+':local:'+JSON.stringify(args),actual,expected});assert.deepEqual(actual,expected);}
  for(const servers of [['[::1%scope]:5300'],['2001:db8::1%1'],['127.0.0.1:5300','[::1%scope]:5301'],[]]){candidate.setServers(servers);reference.setServers(servers);assert.deepEqual(candidate.getServers(),reference.getServers());rows.push({name:label+':servers:'+JSON.stringify(servers),value:candidate.getServers()});}
 }
 const native=addon.open(10,1,0);leases.push(native);
 for(const address of ['::1%scope','::1%','::1%bad name','::ffff:127.0.0.1%x']){assert.equal(addon.local(native,6,address),0);rows.push({name:'actual-cares-local:'+address,status:0,parsed:addon.parse(6,address)});}
 for(const [family,text,expected] of [[6,'::1%scope','::1'],[6,'::1%bad name','::1'],[6,'::1%','::1'],[6,'2001:db8::1%1','2001:db8::1'],[6,'::ffff:127.0.0.1%x','::ffff:127.0.0.1'],[4,'127.0.0.1%scope',null],[6,'invalid%zone',null],[6,'x'.repeat(46)+'%zone',null]]){assert.equal(addon.parse(family,text),expected);rows.push({name:'native-byte-parser:'+family+':'+text,value:expected});}
 const result={scope:'Public pinned JS validation with actual production c-ares native configuration/parser header through NAPI; no guest, provider, query or four-host claim',native:process.version,cares:addon.version(),pass:rows.length,rows};
 fs.writeFileSync(process.env.DNS_ADDRESS_REPORT,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({pass:rows.length,cares:addon.version(),scope:result.scope}));
}finally{for(const lease of leases)addon.close(lease);}
