const path=require('node:path');
if(!process.env.KANDELO_EC_PKCS8_COMPONENT)throw Error('Exact component path required');
const saved=['internalBinding','primordials'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);let api;
try {api=require('./key-platform.cjs').create({ecPkcs8Component:require(process.env.KANDELO_EC_PKCS8_COMPONENT)});}
finally {for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
module.exports=api;
