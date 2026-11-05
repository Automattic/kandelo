'use strict';
const fs=require('node:fs'),path=require('node:path'),util=require('node:util'),os=require('node:os');
const source=fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8');
const factories=Function(source+';return {values:_createNodeValuesPlatform,map:_createNodeSourceMapPlatform};')();
exports.create=function create(){
  const values=factories.values({process,Buffer,util,inspection:util,os,
    signals:os.constants.signals,getDOMException:()=>DOMException});
  return factories.map({values});
};
// Only the public constructor is replaced. Source-map capture/find/stack
// assertions in the upstream file still use native Node and prove no guest
// cache, loader or Error.prepareStackTrace integration.
if(process.env.KANDELO_SOURCE_MAP_PRELOAD==='1'){
  require('node:module').SourceMap=exports.create().SourceMap;
  require('node:module').syncBuiltinESMExports();
}
