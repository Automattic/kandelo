const {internalBinding}=require('internal/test/binding');const builtins=internalBinding('builtins'),collect=()=>gc();
// @shared-build-config-controls
console.log(JSON.stringify({kind:'native-build-config-reference',cases:configurationChecks.length,failures:configurationFailures,observations:configurationChecks}));if(configurationFailures)process.exitCode=1;
