const fs=require('node:fs'),path=require('node:path'),util=require('node:util');
const repo=process.env.KANDELO_KEYPAIR_REPO||path.resolve(__dirname,'../../../..');
if(!process.env.KANDELO_KEYPAIR_COMPONENT)throw Error('Exact native component path must be explicit');
const saved=['internalBinding','primordials'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);
let base;
try {base=require(path.join(repo,'third_party/node-core/tests/asymmetric-keygen/key-platform.cjs')).create({generation:require(process.env.KANDELO_KEYPAIR_COMPONENT)});}
finally {for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
const factory=Function(fs.readFileSync(path.join(repo,'third_party/node-core/node-core.js'),'utf8')+';return _createNodeAsymmetricKeygen;')();
module.exports={...base,...factory({keys:base.privateKeys,values:base.privateValues,types:util.types,codecs:base.privateCodecs})};
