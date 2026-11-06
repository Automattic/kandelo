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
  'raw EC imports derive actual public points and preserve role projections'(api) {
    return ['P-256','P-384','P-521','secp256k1'].map((namedCurve, index) => {
      const size = [32,48,66,32][index], scalar = Buffer.alloc(size); scalar[size-1] = 7;
      const options = {key:scalar,format:'raw-private',asymmetricKeyType:'ec',namedCurve};
      const key = api.createPrivateKey(options), derived = api.createPublicKey(options);
      const compressed = derived.export({format:'raw-public',type:'compressed'});
      const publicKey = api.createPublicKey({key:compressed,format:'raw-public',asymmetricKeyType:'ec',namedCurve});
      scalar.fill(0);
      return snapshot({role:key.type,publicRole:derived.type,type:key.asymmetricKeyType,
        details:key.asymmetricKeyDetails,private:key.export({format:'raw-private'}),
        public:publicKey.export({format:'raw-public'}),equal:derived.equals(publicKey),
        der:key.export({format:'der',type:'pkcs8'})});
    });
  },
  'raw OKP imports copy material and serialize through actual providers'(api) {
    return [['ed25519',32],['ed448',57],['x25519',32],['x448',56]].map(([asymmetricKeyType,size]) => {
      const input=Buffer.alloc(size,7), options={key:input,format:'raw-private',asymmetricKeyType};
      const key=api.createPrivateKey(options), pub=api.createPublicKey(options);
      const bytes=pub.export({format:'raw-public'});
      const roundtrip=api.createPublicKey({key:bytes,format:'raw-public',asymmetricKeyType});
      input.fill(8); bytes.fill(9);
      return snapshot({type:key.asymmetricKeyType,private:key.export({format:'raw-private'}),
        public:pub.export({format:'raw-public'}),same:pub.equals(roundtrip),
        der:key.export({format:'der',type:'pkcs8'}),spki:pub.export({format:'der',type:'spki'})});
    });
  },
  'raw PQC material imports through the linked provider and projects public roles'(api) {
    return [['ml-dsa-44',32,'raw-seed'],['ml-kem-512',64,'raw-seed'],['slh-dsa-sha2-128s',64,'raw-private']].map(([asymmetricKeyType,size,format])=> {
      const key=Buffer.alloc(size,7), options={key,format,asymmetricKeyType};
      const privateKey=api.createPrivateKey(options), publicKey=api.createPublicKey(options);
      const bytes=publicKey.export({format:'raw-public'});
      const roundtrip=api.createPublicKey({key:bytes,format:'raw-public',asymmetricKeyType});
      key.fill(8);
      return snapshot({type:privateKey.asymmetricKeyType,role:privateKey.type,publicRole:publicKey.type,
        private:privateKey.export({format}),public:bytes,same:publicKey.equals(roundtrip)});
    });
  },
  'raw format validation retains exact names lengths curves and error classes'(api) {
    const cases=[
      ...['RSA','EC','sm2','unknown','ed25519\0suffix','rsa\0suffix'].map(asymmetricKeyType=>({asymmetricKeyType,format:'raw-public'})),
      ...['rsa','rsa-pss','dsa','dh'].map(asymmetricKeyType=>({asymmetricKeyType,format:'raw-public'})),
      {asymmetricKeyType:'ec',namedCurve:'missing',format:'raw-private'},
      {asymmetricKeyType:'ec',namedCurve:'P-256',format:'raw-seed'},
      {asymmetricKeyType:'ed25519',format:'raw-seed'},
      {asymmetricKeyType:'ml-dsa-44',format:'raw-private'},
      {asymmetricKeyType:'x448',format:'raw-private'},
      {asymmetricKeyType:'ec',namedCurve:'P-384',format:'raw-private'},
      {asymmetricKeyType:'ec',namedCurve:'P-256',format:'raw-public'},
    ];
    return cases.map(options=>error(()=>api.createPublicKey({key:Buffer.alloc(32),...options})));
  },

  'JWK RSA and multi-prime imports use actual prime material and public projection'(api) {
    return ['rsa_private.pem','rsa_private_2048_3_primes.pem'].map(name => {
      const jwk=crypto.createPrivateKey(fixture(name)).export({format:'jwk'});
      const key=api.createPrivateKey({key:jwk,format:'jwk'}), pub=api.createPublicKey({key:jwk,format:'jwk'});
      const publicJwk=pub.export({format:'jwk'});
      return snapshot({private:key.export({format:'jwk'}),public:publicJwk,
        der:key.export({format:'der',type:'pkcs8'}),spki:pub.export({format:'der',type:'spki'}),
        same:pub.equals(api.createPublicKey({key:publicJwk,format:'jwk'})),
        publicAsPrivate:error(()=>api.createPrivateKey({key:publicJwk,format:'jwk'}))});
    });
  },
  'JWK EC coordinates are padded and private points must match the scalar'(api) {
    return ['P-256','P-384','P-521','secp256k1'].map((namedCurve,i)=> {
      const scalar=Buffer.alloc([32,48,66,32][i]); scalar[scalar.length-1]=7;
      const raw={key:scalar,format:'raw-private',asymmetricKeyType:'ec',namedCurve};
      const jwk=crypto.createPrivateKey(raw).export({format:'jwk'});
      const key=api.createPrivateKey({key:jwk,format:'jwk'}),pub=api.createPublicKey({key:jwk,format:'jwk'});
      const wrong={...jwk,d:Buffer.alloc(scalar.length,1).toString('base64url')};
      const zero={...jwk,x:'',y:''};
      return snapshot({private:key.export({format:'jwk'}),public:pub.export({format:'jwk'}),
        der:key.export({format:'der',type:'pkcs8'}),wrong:error(()=>api.createPrivateKey({key:wrong,format:'jwk'})),
        invalidPoint:error(()=>api.createPublicKey({key:zero,format:'jwk'}))});
    });
  },
  'JWK OKP and AKP imports validate actual public and private relations'(api) {
    return [['ed25519',32,'raw-private'],['ed448',57,'raw-private'],['x25519',32,'raw-private'],
      ['x448',56,'raw-private'],['ml-dsa-44',32,'raw-seed'],['ml-kem-512',64,'raw-seed'],
      ['slh-dsa-sha2-128s',64,'raw-private']].map(([asymmetricKeyType,size,format])=> {
      const source=crypto.createPrivateKey({key:Buffer.alloc(size,7),format,asymmetricKeyType});
      const jwk=source.export({format:'jwk'}),key=api.createPrivateKey({key:jwk,format:'jwk'});
      const pub=api.createPublicKey({key:jwk,format:'jwk'}),field=jwk.kty==='AKP'?'pub':'x';
      const bad={...jwk,[field]:Buffer.from(jwk[field],'base64url').fill(8).toString('base64url')};
      return snapshot({private:key.export({format:'jwk'}),public:pub.export({format:'jwk'}),
        der:key.export({format:'der',type:'pkcs8'}),wrong:error(()=>api.createPrivateKey({key:bad,format:'jwk'}))});
    });
  },
  'JWK getters retain pinned access order and validation precedence'(api) {
    const values=[{}, {kty:'RSA',n:0,e:0}, {kty:'EC',crv:'missing'},
      {kty:'EC',crv:'P-256',x:0,y:0}, {kty:'OKP',crv:'bad',x:0},
      {kty:'AKP',alg:'bad',pub:0}, {kty:'AKP',alg:'ML-DSA-44',pub:0},
      {kty:'OKP',crv:'Ed25519',x:'',d:0}, {kty:'RSA',n:'',e:'',d:'',oth:[]},
      {kty:'RSA',n:'',e:'',oth:[]}, {kty:'oct'}, {kty:'RSA\0suffix',n:'',e:''}];
    return values.map(value=> {
      const reads=[],key=new Proxy(value,{get(target,name){reads.push(String(name));return target[name];}});
      const failure=error(()=>api.createPublicKey({key,format:'jwk'})); return {reads,failure};
    });
  },
  'JWK getter exceptions preserve identity where the pinned native owner propagates them'(api) {
    return [['OKP','crv'],['OKP','x'],['OKP','d'],['AKP','alg'],['AKP','pub'],['AKP','priv'],['EC','x'],['EC','y'],['EC','d']].map(([kty,field])=> {
      const sentinel=Error('getter '+field), key={kty,crv:'P-256'};
      Object.defineProperty(key,field,{get(){throw sentinel;}});
      try { api.createPublicKey({key,format:'jwk'}); return false; } catch(e) {return e===sentinel;}
    });
  },
  'JWK private AKP export keeps unavailable seed failures visible'(api) {
    return ['ml_dsa_44_private_priv_only.pem','ml_kem_512_private_priv_only.pem'].map(name=> {
      const key=api.createPrivateKey(fixture(name));
      return {private:error(()=>key.export({format:'jwk'})),public:api.createPublicKey(key).export({format:'jwk'})};
    });
  },

  'JWK inherited accessors cannot intercept own exported properties'(api) {
    const key=api.createPrivateKey(fixture('rsa_private.pem'));
    const names=['kty','n','e','d','p','q','dp','dq','qi'],saved=names.map(n=>Object.getOwnPropertyDescriptor(Object.prototype,n));
    const calls=[]; let jwk;
    try {
      for(const name of names) Object.defineProperty(Object.prototype,name,{configurable:true,set(){calls.push(name);throw Error('intercepted');}});
      jwk=key.export({format:'jwk'});
    } finally {
      names.forEach((name,i)=>saved[i]?Object.defineProperty(Object.prototype,name,saved[i]):delete Object.prototype[name]);
    }
    return {calls,properties:Object.keys(jwk).map(name=>{
      const d=Object.getOwnPropertyDescriptor(jwk,name);return [name,d.writable,d.enumerable,d.configurable];}),jwk};
  },
  'JWK malformed RSA prime information and unsupported exports retain native errors'(api) {
    const jwk=crypto.createPrivateKey(fixture('rsa_private.pem')).export({format:'jwk'});
    const mutations=[{p:'AQ'},{oth:[]},{oth:{}},{oth:[null]},{oth:[{r:'AQ',d:'AQ',t:'AQ'}]},
      {oth:Array(9).fill({r:'AQ',d:'AQ',t:'AQ'})},{oth:[{r:1,d:'AQ',t:'AQ'}]}];
    return {invalid:mutations.map(change=>error(()=>api.createPrivateKey({key:{...jwk,...change},format:'jwk'}))),
      unsupported:['rsa_pss_private_2048_sha256_sha256_16.pem','dsa_private_pkcs8.pem'].map(name=>error(()=>api.createPrivateKey(fixture(name)).export({format:'jwk'})))};
  },

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
