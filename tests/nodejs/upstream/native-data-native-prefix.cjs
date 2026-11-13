'use strict';
function assert(value, message = 'native data property assertion failed') {
  if (!value) throw Error(message);
}
// @shared-native-data-controls
const make = setter => ({target: process, key: setter ? 'debugPort' : 'ppid'});
