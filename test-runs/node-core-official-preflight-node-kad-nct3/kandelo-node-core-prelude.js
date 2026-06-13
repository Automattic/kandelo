'use strict';

const testFile = process.argv[2];
if (!testFile) {
  throw new Error('kandelo-node-core-prelude requires an official test path as argv[2]');
}

process.argv[1] = testFile;
process.env.NODE_SKIP_FLAG_CHECK = '1';
process.env.NODE_DISABLE_COLORS = process.env.NODE_DISABLE_COLORS || '1';

process.config = process.config || {};
process.config.variables = Object.assign({
  asan: 0,
  debug_node: 0,
  icu_gyp_path: '',
  is_debug: 0,
  node_shared: false,
  node_shared_openssl: false,
  node_use_openssl: Boolean(process.versions && process.versions.openssl),
  openssl_quic: 0,
  shlib_suffix: '.so',
  single_executable_application: false,
  ubsan: 0,
  v8_enable_i18n_support: 0,
  want_separate_host_toolset: 0
}, process.config.variables || {});
process.config.target_defaults = Object.assign({
  default_configuration: 'Release'
}, process.config.target_defaults || {});

process.features = Object.assign({
  cached_builtins: false,
  debug: false,
  inspector: false,
  ipv6: true,
  tls: Boolean(process.versions && process.versions.openssl)
}, process.features || {});

if (!Array.isArray(process.execArgv)) process.execArgv = [];
if (!process.execPath) process.execPath = '/usr/bin/node';

require(testFile);
