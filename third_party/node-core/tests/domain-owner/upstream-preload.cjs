'use strict';
// Complete candidate Domain source over actual pinned native Node dependencies.
// This does not run Kandelo's uncompiled VM callback/async/fatal bridges.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const assert=require('node:assert/strict');assert.equal(process.version,'v26.13.0');
const core=fs.readFileSync(path.resolve(__dirname,'../../node-core.js'),'utf8');
const factory=Function(core+';return _createNodeDomainPlatform;')();
let domain;
const original=Module._load;
Module._load=function(request,parent,isMain){
 if(request==='domain'||request==='node:domain')return domain??=factory({process,
  events:require('node:events'),values:{errors:require('internal/errors')},
  async:{api:require('node:async_hooks'),domain:require('internal/async_hooks')}});
 return Reflect.apply(original,this,arguments);
};
