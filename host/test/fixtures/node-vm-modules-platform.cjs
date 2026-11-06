'use strict';
// Pinned candidate JS module classes over explicit native26 ModuleWrap and
// realm/registry dependencies. This never substitutes those owners in product.
const fs=require('fs'),path=require('path'),vm=require('vm'),util=require('util');
const {internalBinding}=require('internal/test/binding');
const raw=internalBinding('module_wrap'),esm=require('internal/modules/esm/utils');
const methods=Object.fromEntries(Object.getOwnPropertyNames(raw.ModuleWrap.prototype)
 .filter(n=>n!=='constructor').map(n=>[n,Object.getOwnPropertyDescriptor(raw.ModuleWrap.prototype,n).value]));
const base=path.resolve(__dirname,'../../../third_party/node-core');
const source=fs.readFileSync(path.join(base,'node-core.js'),'utf8');
const classes=fs.readFileSync(process.env.KANDELO_VM_MODULES_FACTORY,'utf8');
const complete=source.includes('function _createNodeVmModules(')?source:source+'\n'+classes;
const factories=Function(complete+';return {modules:_createNodeVmModules,values:_createNodeValuesPlatform};')();
exports.create=function create(){
 const realms=new WeakMap(),globals=new WeakMap();
 const values=factories.values({process:{platform:process.platform,emitWarning(){}},Buffer,util,
  inspection:util,os:require('os'),signals:require('os').constants.signals});
 const native={__kandeloVmModuleOperation(op,...args){
  if(op==='constants')return Object.fromEntries(Object.entries(raw).filter(([n])=>/^k(?:Uninstantiated|Instantiating|Instantiated|Evaluating|Evaluated|Errored|SourcePhase|EvaluationPhase)$/.test(n)));
  if(op==='new'){
   const [prototype,identifier,global,body,line,column,cache]=args;
   // Preserve native constructor-owned metadata before installing the candidate
   // bridge prototype, whose accessors otherwise intercept V8's own Set calls.
   const owner=new raw.ModuleWrap(identifier,global===globalThis?undefined:realms.get(global),body,line,column,cache);
   Object.setPrototypeOf(owner,prototype);return owner;
  }
  if(op==='register'){esm.registerModule(args[0],args[1]);return;}
  if(op==='topLevelAwait')return args[0].hasTopLevelAwait;
  if(op==='asyncGraph')return args[0].hasAsyncGraph;
  const method={requests:'getModuleRequests',namespace:'getNamespace',status:'getStatus',error:'getError',cache:'createCachedData',moduleSource:'getModuleSourceObject'}[op]||op;
  if(typeof methods[method]!=='function')throw Error('Uncontrolled VM module operation '+op);
  return Reflect.apply(methods[method],args[0],args.slice(1));
 }};
 const classes=factories.modules({native,values,types:util.types,inspection:util,assert:require('assert'),
  isContext:vm.isContext,contextGlobal(context){if(context===undefined)return globalThis;
   let global=globals.get(context);if(!global){global=vm.runInContext('globalThis',context);globals.set(context,global);realms.set(global,context);}return global;}});
 return {...classes,createContext:vm.createContext};
};
