// The native and guest harnesses supply the real binding and check/assertEq.
check('all-original-table-containers-have-null-prototypes',()=>{
  assertEq(Object.getPrototypeOf(constants),null);assertEq(Object.keys(constants).join(','),'os,fs,crypto,zlib,trace,internal');
  for(const table of [constants.os,constants.os.dlopen,constants.os.errno,constants.os.signals,constants.os.priority,constants.fs,constants.crypto,constants.zlib,constants.trace,constants.internal])assertEq(Object.getPrototypeOf(table),null);
});
check('native-values-have-immutable-enumerable-descriptors',()=>{
  let count=0;function visit(table){for(const key of Object.keys(table)){const d=Object.getOwnPropertyDescriptor(table,key);assertEq(d.enumerable,true);if(d.value&&typeof d.value==='object'){assertEq(d.writable&&d.configurable,true);visit(d.value)}else{assertEq(d.writable||d.configurable,false);assertEq(['number','string'].includes(typeof d.value),true);count++}}}visit(constants);assertEq(count>400,true);
});
check('container-properties-remain-mutable-without-altering-constant-values',()=>{
  const saved=constants.os;constants.os={replacement:true};assertEq(constants.os.replacement,true);constants.os=saved;
  const name=Object.keys(constants.os.signals)[0],before=constants.os.signals[name];assertEq(Reflect.set(constants.os.signals,name,999),false);assertEq(Reflect.deleteProperty(constants.os.signals,name),false);assertEq(constants.os.signals[name],before);
});
check('compression-api-declarations-and-infinity-are-complete',()=>{
  assertEq(Object.keys(constants.zlib).length,171);assertEq(constants.zlib.Z_MAX_CHUNK,Infinity);assertEq(constants.zlib.Z_MIN_CHUNK,64);
  assertEq(constants.zlib.ZSTD_COMPRESS,10);assertEq(constants.zlib.ZSTD_DECOMPRESS,11);assertEq(constants.zlib.BROTLI_DECODE,8);assertEq(constants.zlib.BROTLI_ENCODE,9);
  for(const name of ['BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET','BROTLI_PARAM_LARGE_WINDOW','ZSTD_error_noForwardProgress_inputEmpty','ZSTD_c_nbWorkers'])assertEq(typeof constants.zlib[name],'number');
});
check('trace-and-extensionless-format-values-come-from-native-declarations',()=>{
  assertEq(Object.keys(constants.trace).length,23);assertEq(constants.trace.TRACE_EVENT_PHASE_BEGIN,'B'.charCodeAt(0));assertEq(constants.trace.TRACE_EVENT_PHASE_END,'E'.charCodeAt(0));
  assertEq(constants.internal.EXTENSIONLESS_FORMAT_JAVASCRIPT,0);assertEq(constants.internal.EXTENSIONLESS_FORMAT_WASM,1);
});
check('crypto-api-values-and-default-list-remain-real-header-data',()=>{
  assertEq(typeof constants.crypto.OPENSSL_VERSION_NUMBER,'number');assertEq(constants.crypto.OPENSSL_VERSION_NUMBER>0,true);assertEq(constants.crypto.TLS1_2_VERSION,0x0303);
  assertEq(typeof constants.crypto.defaultCoreCipherList,'string');assertEq(constants.crypto.defaultCoreCipherList.startsWith('TLS_AES_256_GCM_SHA384:'),true);assertEq(constants.crypto.RSA_PKCS1_PADDING,1);
});
