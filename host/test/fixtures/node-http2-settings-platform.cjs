'use strict';
// Candidate settings/core/Buffer/errors over explicit native memory/type/process
// boundaries. No native HTTP2 binding/session is supplied to the candidate.
const fs=require('node:fs'),path=require('node:path'),util=require('node:util');
const root=path.resolve(__dirname,'../../..');
function create(){
 const {Buffer,values,allocator}=require('./node-buffer-pool.cjs').create();
 const source=fs.readFileSync(process.env.NODE_HTTP2_GENERATED||path.join(root,'third_party/node-core/node-core.js'),'utf8');
 const factory=Function(source+';return _createNodeHttp2Settings;')();
 const api=factory({Buffer,values,allocator,types:util.types,process});
 const bootstrap=fs.readFileSync(path.join(root,'packages/registry/node-compat/bootstrap.js'),'utf8');
 const route=bootstrap.split('\n').find(line=>line.trimStart().startsWith("'http2':"));
 if(!route)throw Error('Missing public HTTP2 builtin route');
 const builtin=Function('_nodeHttp2Settings','return ({'+route+'})["http2"];')(api);
 if(builtin!==api)throw Error('Public HTTP2 route did not select the actual settings owner');
 return {api,Buffer,values,allocator,root};
}
module.exports={create};
