'use strict';
// Actual numeric owner; the shared control loads the current production bundle.
const { createAsyncPlatformControl } = require('./node-async-platform.cjs');
module.exports.createAsyncPlatformControl = () => createAsyncPlatformControl({
  defaultTrigger: require(process.env.KANDELO_DEFAULT_TRIGGER_ADDON),
});
