const {internalBinding}=require('internal/test/binding');const binding=internalBinding('messaging'),util=internalBinding('util'),symbols=internalBinding('symbols'),getTransferable=()=>require('internal/worker/js_transferable'),getCloneClasses=()=>require('internal/worker/clone_dom_exception');
// @shared-messaging-controls
console.log(JSON.stringify({kind:'native-messaging-registration-reference',cases:observations.length,failures,observations}));if(failures)process.exitCode=1;
