'use strict';
const fs=require('node:fs'),path=require('node:path');const {fileURLToPath}=require('node:url');
const source=fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8');
const factory=Function(source+';return _createNodeGlobPlatform;')();
exports.create=function(){
 const paths=require('./node-realpath-platform.cjs').create();
 const directory=require('./node-readdir-platform.cjs').create({fs:paths.api});
 Object.assign(paths.api,directory.api);Object.assign(paths.promises,directory.promises);
 const glob=factory({fs:paths.api,process,path,values:directory.values,dirents:directory.utilities,
  toPathIfFileURL:paths.toPathIfFileURL});
 Object.assign(paths.api,glob.api);Object.assign(paths.promises,glob.promises);
 return {api:paths.api,promises:paths.promises};
};
