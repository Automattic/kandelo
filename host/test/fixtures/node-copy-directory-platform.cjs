'use strict';
// Candidate cp algorithms/native worker; explicit native Node dependencies for
// already-owned fs/Dir/metadata, primordials, errors, path and callbackify.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const descriptors=['internalBinding','primordials'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
const { internalBinding } = require('internal/test/binding');
for(const [name,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}
const root = path.resolve(__dirname, '../../..');
exports.create = function create() {
  const source = fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
  const adapter = fs.readFileSync(process.env.KANDELO_CP_ADAPTER,'utf8');
  const factories = Function(source+'\n'+adapter+';return {values:_createNodeValuesPlatform,cp:_createNodeCopyDirectoryPlatform};')();
  const values = factories.values({process,Buffer,util,inspection:util,
    uv:{binding:internalBinding('uv')},os:require('node:os'),
    signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
  const filesystem = {...fs,promises:{...fs.promises}};
  const native = require(process.env.KANDELO_CP_COMPONENT);
  const cp = factories.cp({process,fs:filesystem,path,util,types:util.types,values,native,
    getAssert:()=>require('internal/assert'),
    constants:internalBinding('constants'),permission:{isEnabled:()=>false},
    utils:{getValidatedPath:require('internal/fs/utils').getValidatedPath},
    internalModuleStat:internalBinding('fs').internalModuleStat});
  return {api:cp.api,promises:cp.promises,binding:cp.binding,native};
};
