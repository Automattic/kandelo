'use strict';
// Candidate public algorithms; actual native Node handles/clone markers are
// explicit dependencies. This does not exercise the new guest JSAPI bridge.
const fs=require('node:fs'),path=require('node:path'),util=require('node:util');
const root=path.resolve(__dirname,'../../..');
const descriptors=['internalBinding','primordials'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);
const {internalBinding}=require('internal/test/binding');
for(const [key,d] of descriptors){if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];}
const binding=internalBinding('block_list');
const factories=Function(fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8')+
 ';return {values:_createNodeValuesPlatform,address:_createNodeAddressRules};')();
const web=Function(fs.readFileSync(path.join(root,'third_party/node-web-platform/node-web-platform.js'),'utf8')+
 ';return _createNodeWebPlatform;')()();
exports.native={addressRules(operation,...args){
 let value;
 if(operation==='families')value=[binding.AF_INET,binding.AF_INET6];
 else if(operation==='createAddress')value=new binding.SocketAddress(...args.slice(1));
 else if(operation==='createList')value=new binding.BlockList();
 else if(operation==='detail'){
  const d=args[0].detail({});value=[d.address,d.port,d.family,d.flowlabel];
 }else{
  const names={rules:'getRules',size:'getSize'};
  value=Reflect.apply(args[0][names[operation]||operation],args[0],args.slice(1));
 }
 return {value};
}};
exports.clone={protocol:require('internal/worker/js_transferable')};
exports.factories=factories;
exports.create=function create(){
 const values=factories.values({process,Buffer,util,inspection:util,os:require('node:os'),
  signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
 const platform=factories.address({values,inspection:util,clone:exports.clone,native:exports.native,
  URLParse:web.URL.parse.bind(web.URL)});
 return {...platform,BlockList:platform.require('internal/blocklist').BlockList,
  SocketAddress:platform.require('internal/socketaddress').SocketAddress};
};
