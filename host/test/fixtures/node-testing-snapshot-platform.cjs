'use strict';
// Actual candidate tree/snapshot/option owners over explicit native process,
// timer, filesystem, VM and SavedFrame/caller dependency boundaries. No native
// node:test module or replacement snapshot manager is supplied to this owner.
const fs=require('node:fs'),path=require('node:path');
const {internalBinding}=require('internal/test/binding');
const root=path.resolve(__dirname,'../../..');
function create(cliOptions){
 const source=fs.readFileSync(process.env.SNAPSHOT_TEST_BUNDLE||path.join(root,'third_party/node-core/node-core.js'),'utf8');
 const {testing,reader}=Function(source+';return {testing:_createNodeTestingPlatform,reader:_createNodeTestOptionReader};')();
 const values={errors:require('internal/errors'),validators:require('internal/validators'),util:require('internal/util'),require};
 const optionReader=reader({cliOptions,values});
 const owner=testing({process,values,assert:require('node:assert'),comparisons:require('internal/util/comparisons'),types:require('node:util').types,inspection:require('internal/util/inspect'),eventTarget:require('internal/event_target'),assertUtils:require('internal/assert/utils'),getCallerLocation:internalBinding('util').getCallerLocation,events:require('node:events'),abort:require('internal/abort_controller'),async:require('node:async_hooks'),timers:require('node:timers'),timerPromises:require('node:timers/promises'),path,fs,fsUtils:require('internal/fs/utils'),os:require('node:os'),url:require('internal/url'),Module:require('node:module'),vm:require('node:vm'),diagnostics:require('node:diagnostics_channel'),queueMicrotask,stream:require('node:stream'),streamRequire:require,getOptionValue:optionReader});
 return {api:owner.api,owner,options:{updateSnapshots:optionReader('--test-update-snapshots')}};
}
module.exports={create};
