'use strict';
// Focused component boundary: actual conditional header collector, native FS
// and signal bags, real VM compilation/ticks and the actual production CJS
// loader. No guest JSAPI object construction or full crypto API proof.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../../../..');
const bundle=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const source=fs.readFileSync(path.join(root,'packages/registry/node-compat/bootstrap.js'),'utf8');
const factories=Function(bundle+';return {modules:_createNodePublicConstantModules};')();
exports.create=function create(options={}) {
  const native=require(process.env.CONSTANT_NATIVE_ADDON);
  // NAPI's object factory has an ordinary prototype. The tested SM source
  // creates null prototypes directly; this bridge adaptation is explicit.
  for(const object of [native,native.os,native.os.errno,native.os.priority,native.os.dlopen,native.crypto])Object.setPrototypeOf(object,null);
  const os=Object.create(null);
  Object.defineProperty(os,'UV_UDP_REUSEADDR',Object.getOwnPropertyDescriptor(native.os,'UV_UDP_REUSEADDR'));
  Object.assign(os,{dlopen:native.os.dlopen,errno:native.os.errno,signals:require('node:os').constants.signals,priority:native.os.priority});
  const binding=Object.assign(Object.create(null),{os,fs:fs.constants,crypto:native.crypto});
  const existingCryptoAPI=Object.create(null);
  // This opaque object stands for the already constructed crypto API object;
  // no methods/providers are fabricated or claimed by this constants control.
  const cliOptions={tlsCipherList:options.tlsCipherList??native.crypto.defaultCoreCipherList};
  let proc,registry;
  const fixture=require(path.join(root,'host/test/fixtures/node-module-records.cjs'));
  const api=fixture.create({skipESMResolver:true,configureBuiltins(builtins,boundary,values){
    proc=boundary;registry=builtins;proc.moduleLoadList=[];
    const initial=source.slice(source.indexOf('const _nodePublicConstants ='),source.indexOf('let _nodeDomain, _nodeFfi;'));
    const cryptoGetter=source.match(/    get crypto\(\) \{ return _nodePublicConstants.load\('crypto'\); \},/)[0];
    const constantsGetter=source.match(/    get constants\(\) \{ return _nodePublicConstants.load\('constants'\); \},/)[0];
    const context={process:proc,_nodeValues:values,_nodeConstantBinding:binding,crypto:existingCryptoAPI,tls:Object.create(null),
      _createNodePublicConstantModules:factories.modules,_builtinModules:builtins,
      _nodeNative:{cliOptions,evalScriptAsFunction:(text,filename,line)=>{
        if(line!==1)throw Error('unexpected source origin line');return vm.runInThisContext(text,{filename});
      }}};
    vm.createContext(context);
    const properties=vm.runInContext(initial+';Object.getOwnPropertyDescriptors({'+cryptoGetter+constantsGetter+'})',context);
    Object.defineProperties(builtins,properties);
  }});
  return {proc,registry,binding,existingCryptoAPI,cliOptions,Module:api.Module,
    req:api.Module.createRequire(path.join(root,'constants-control-main.cjs'))};
};
