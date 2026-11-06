'use strict';
// Complete candidate OutgoingMessage over actual native stream/socket/clock
// owners. This is a component boundary, not guest or JSAPI conformance.
const fs=require('node:fs'),path=require('node:path');
const {primordials}=require('internal/test/binding');
const root=path.resolve(__dirname,'../../..');
const source=fs.readFileSync(process.env.HTTP_OUTGOING_GENERATED || path.join(root,'third_party/node-core/node-core.js'),'utf8');
const factory=Function('_createNodePrimordials',source+';return _createNodeHttpOutgoing;')(()=>primordials);
function create(BufferOwner=Buffer,values={errors:require('internal/errors'),validators:require('internal/validators'),util:require('internal/util'),require}){
 // Production initializes this pinned debug owner before HTTP bootstrap.
 values.require('internal/util/debuglog').initializeDebugEnv(process.env.NODE_DEBUG);
 return factory({process,Buffer:BufferOwner,stream:require('node:stream'),events:require('node:events'),
  streamsState:require('internal/streams/state'),assert:require('internal/assert'),
  async:require('internal/async_hooks'),types:require('internal/util/types'),
  values,
  setUnrefTimeout(fn,delay){return setTimeout(fn,delay).unref();},insecureHTTPParser:false});
}
module.exports={create,root};
