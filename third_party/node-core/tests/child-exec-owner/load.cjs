'use strict';
const fs=require('node:fs'),path=require('node:path'),native=require('node:child_process'),util=require('node:util'),os=require('node:os'),timers=require('node:timers');
module.exports=function load(mode,repo){
 const bundle=fs.readFileSync(path.join(repo,'third_party/node-core/node-core.js'),'utf8');
 if(mode==='native')return native;
 if(mode==='before'){
  const source=fs.readFileSync(path.join(repo,'../before/packages/registry/node-compat/bootstrap.js'),'utf8');
  const a=source.indexOf('    // Shared by exec/execFile: accumulate stdout/stderr'),b=source.indexOf('\n})();',a);
  if(a<0||b<=a)throw Error('exact baseline collector range');
  return Function('_spawn','execSync','execFileSync','spawnSync',source.slice(a,b))(native.spawn,native.execSync,native.execFileSync,native.spawnSync);
 }
 const factories=Function(bundle+';return {values:_createNodeValuesPlatform,child:_createNodeChildExecPlatform,primordials:_createNodePrimordials};')();
 const values=factories.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
 // Execute the actual production bootstrap IIFE and final factory wiring.
 // The sole substitution supplies the explicit native spawn dependency just
 // before publication; its guest implementation is not being evaluated here.
 const source=fs.readFileSync(path.join(repo,'packages/registry/node-compat/bootstrap.js'),'utf8');
 const a=source.indexOf('const child_process = (() => {'),b=source.indexOf('\n// spawn() creates this shared public class.',a);
 if(a<0||b<=a)throw Error('actual child public bootstrap section');
 let selected=source.slice(a,b);const marker='    const api = _createNodeChildExecPlatform({';
 if(selected.split(marker).length!==2)throw Error('actual child factory publication marker');
 selected=selected.replace(marker,'    _spawn = nativeSpawn;\n'+marker);
 return Function('_createNodePrimordials','_createNodeChildExecPlatform','Buffer','timers','_nodeValues','nativeSpawn','_nodeNative',selected+';return child_process;')(factories.primordials,factories.child,Buffer,timers,values,native.spawn,new Proxy(Object.create(null),{get(_target,key){throw Error("Guest native dependency not supplied by collector fixture: "+String(key));}}));
};
