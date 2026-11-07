'use strict';
const fs = require('node:fs');const path=require('node:path');
module.exports = function create(root,component) {
  const bundle=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
  const factories=Function(bundle+';return {sea:_createNodeSeaPlatform,values:_createNodeValuesPlatform};')();
  const nativeBinding=require(component);
  const util=require('node:util'),os=require('node:os');
  const values=factories.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
  const api=factories.sea({native:{seaBinding:()=>nativeBinding},values,
    TextDecoder:require('node:util').TextDecoder,Blob:require('node:buffer').Blob});
  return {api,nativeBinding};
};
