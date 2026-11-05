'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const source = path.resolve(__dirname, '../../../.context/nodejs-lts-cache-v2/node-v26.13.0');
const fixture = name => fs.readFileSync(path.join(source, 'test/fixtures/keys', name));
function error(run) { try { run(); return null; } catch (e) { return { name: e.name, code: e.code, message: e.message }; } }
function snapshot(value) {
  if (typeof value === 'bigint') return value.toString();
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
  if (Array.isArray(value)) return value.map(snapshot);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,snapshot(v)]));
  return value;
}
exports.controls = {
  'secret material is copied and independent exports cannot mutate it'(api) {
    const input = Buffer.from([1, 2, 3, 4]); const key = api.createSecretKey(input);
    input.fill(9); const exported = key.export(); exported.fill(8);
    return snapshot({ type: key.type, size: key.symmetricKeySize, bytes: key.export(),
      jwk: key.export({ format: 'jwk' }), same: key.equals(api.createSecretKey(Buffer.from([1,2,3,4]))),
      different: key.equals(api.createSecretKey(Buffer.from([1,2,3]))), empty: api.createSecretKey(Buffer.alloc(0)).export() });
  },
  'PEM and DER preserve RSA and EC private/public roles and details'(api) {
    return ['rsa_private.pem','ec-key.pem'].map(name => {
      const key = api.createPrivateKey(fixture(name)), pub = api.createPublicKey(key);
      const der = key.export({format:'der',type:'pkcs8'}), spki = pub.export({format:'der',type:'spki'});
      const copy = api.createPrivateKey({key:der,format:'der',type:'pkcs8'});
      const copyPub = api.createPublicKey({key:spki,format:'der',type:'spki'});
      const detail = key.asymmetricKeyDetails; detail.modulusLength = -1;
      return snapshot({type:key.type,algorithm:key.asymmetricKeyType,details:key.asymmetricKeyDetails,
        publicType:pub.type,publicDetails:pub.asymmetricKeyDetails,der,spki,
        same:copy.equals(key),samePublic:copyPub.equals(pub),differentRole:key.equals(pub),
        pem:copy.export({format:'pem',type:'pkcs8'}),publicPem:copyPub.export({format:'pem',type:'spki'})});
    });
  },
  'real public input and PSS restrictions retain actual backend metadata'(api) {
    return ['rsa_public.pem','rsa_pss_private_2048_sha256_sha256_16.pem','dsa_private_pkcs8.pem'].map(name=>{
      const key = name.includes('private') ? api.createPrivateKey(fixture(name)) : api.createPublicKey(fixture(name));
      return snapshot({type:key.type,algorithm:key.asymmetricKeyType,details:key.asymmetricKeyDetails});
    });
  },
  'encrypted private inputs roundtrip and report native failures'(api) {
    const pem=crypto.createPrivateKey(fixture('rsa_private.pem')).export({format:'pem',type:'pkcs8',cipher:'aes-256-cbc',passphrase:'password'});
    const key=api.createPrivateKey({key:pem,passphrase:'password'});
    const encrypted=key.export({format:'pem',type:'pkcs8',cipher:'aes-256-cbc',passphrase:'other'});
    return {same:api.createPrivateKey({key:encrypted,passphrase:'other'}).equals(key),
      missing:error(()=>api.createPrivateKey(pem)),bad:error(()=>api.createPrivateKey({key:pem,passphrase:'wrong'})),
      unknownCipher:error(()=>key.export({format:'pem',type:'pkcs8',cipher:'not-a-cipher',passphrase:'other'}))};
  },
  'key receivers and input validation reject forged public properties'(api) {
    const secret=api.createSecretKey('key'), fake=Object.create(api.KeyObject.prototype);
    return {type:error(()=>Object.getOwnPropertyDescriptor(api.KeyObject.prototype,'type').get.call(fake)),
      export:error(()=>Object.getPrototypeOf(secret).export.call(fake)),
      invalid:error(()=>api.createSecretKey({type:'secret',export(){throw Error('must not run');}})),
      wrongRole:error(()=>api.createPrivateKey(secret)),
      equality:error(()=>secret.equals({type:'secret'})),symbols:Object.getOwnPropertySymbols(secret).map(String)};
  },
  'deep comparison uses actual key material and roles'(api) {
    const key=api.createSecretKey('key'),same=api.createSecretKey('key'),different=api.createSecretKey('different');
    const privateKey=api.createPrivateKey(fixture('rsa_private.pem'));
    return [api.isDeepStrictEqual(key,same),api.isDeepStrictEqual(key,different),
      api.isDeepStrictEqual({key}, {key:same}),api.isDeepStrictEqual(privateKey,api.createPublicKey(privateKey))];
  },
  'HMAC consumes real secret key material'(api) {
    return ['','key','\0secret😀'].map(input=>api.createHmac('sha256',api.createSecretKey(Buffer.from(input))).update('message').digest('hex'));
  },
};
