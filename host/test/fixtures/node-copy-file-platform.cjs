'use strict';
// Selected public source with real pinned Node native requests. This does not
// execute the guest JSAPI bridge; the portable C++ owner has separate controls.
const fs = require('node:fs'), path = require('node:path'), util = require('node:util'), os = require('node:os');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const globals = ['internalBinding', 'primordials'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
const { internalBinding } = require('internal/test/binding');
for (const [key, descriptor] of globals) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
}
const nativeFs = internalBinding('fs'), nativeUv = internalBinding('uv');
const core = path.resolve(__dirname, '../../../third_party/node-core');
function adapterSource() {
  const manifest = JSON.parse(fs.readFileSync(path.join(core, 'copy-file-sources.json'), 'utf8'));
  const sources = {}, sections = {};
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const [name, item] of Object.entries(manifest.sources)) {
    const raw = fs.readFileSync(path.join(core, item.path));
    if (digest(raw) !== item.sha256) throw new Error('copyFile source identity: ' + name);
    sources[name] = raw.toString('utf8');
  }
  for (const [name, item] of Object.entries(manifest.selections)) {
    const source = sources[item.source], offset = source.indexOf(item.start);
    if (offset < 0 || source.indexOf(item.start, offset + 1) >= 0) throw new Error('copyFile selector: ' + name);
    const section = source.slice(offset, offset + item.length);
    if (digest(section) !== item.sha256) throw new Error('copyFile section identity: ' + name);
    sections[name] = section;
  }
  const error = sections['shared-handleError'].replace('  ErrorCaptureStackTrace(error, handleErrorFromBinding);',
    '  if (ErrorCaptureStackTrace !== undefined) ErrorCaptureStackTrace(error, handleErrorFromBinding);');
  return fs.readFileSync(path.join(core, 'copy-file-adapter.js'), 'utf8')
    .replace('/* NODE_COPY_FILE_SHARED */', [sections['shared-makeCallback'], sections['shared-vfsVoid'], error].join('\n'))
    .replace('/* NODE_COPY_FILE_PUBLIC */', [sections['public-callback'], sections['public-sync']].join('\n'))
    .replace('/* NODE_COPY_FILE_PROMISE */', sections['promise-copyFile']);
}
const source = fs.readFileSync(path.join(core, 'node-core.js'), 'utf8');
const factories = Function(source + '\n' + adapterSource() + ';return { values:_createNodeValuesPlatform, stats:_createNodeFsStats, copy:_createNodeCopyFile, errors:_createNodeFsSystemErrors };')();
const bootstrap = fs.readFileSync(path.resolve(__dirname, '../../../packages/registry/node-compat/bootstrap.js'), 'utf8');
const relay = bootstrap.slice(bootstrap.indexOf('function _errnoToCode('), bootstrap.indexOf('function _checkErrno('));
const truncationSource = fs.readFileSync(path.join(core, 'fs-truncate-adapter.js'), 'utf8');
const errorStart = truncationSource.indexOf('    function makeError(');
const makeErrorSource = truncationSource.slice(errorStart, truncationSource.indexOf('\n    }', errorStart) + 6);
exports.create = function create() {
  const uv = { binding:nativeUv, getSystemErrorName:util.getSystemErrorName };
  const errorOwner = factories.errors({ uv, codecs:{ decodeBytes:bytes => Buffer.from(bytes).toString('utf8') } });
  const throwErrno = Function('owner', relay + ';_nodeFsSystemErrors=owner;return _throwErrno;')(errorOwner);
  const makeError = Function('platform', makeErrorSource + ';return makeError;')({ throwErrno });
  const values = factories.values({ process, Buffer, util, inspection:util, uv, os,
    signals:os.constants.signals, getDOMException:() => DOMException });
  const truncation = { vfsState:{ handlers:null }, FSReqCallback:nativeFs.FSReqCallback, makeError };
  const utils = factories.stats({ fs, process, Buffer, types:util.types, values, truncation, native:{},
    permissionEnabled:() => false, toPathIfFileURL:value => value instanceof URL ? fileURLToPath(value) : value });
  const native = {
    fsCopyFileSync(src, dest, mode) {
      try { nativeFs.copyFile(src, dest, mode); return 0; }
      catch (error) { if (typeof error.errno !== 'number') throw error; return error.errno; }
    },
    fsCopyFile(src, dest, mode, request) {
      return nativeFs.copyFile(src, dest, mode, typeof request === 'function' ? nativeFs.kUsePromises : request);
    },
  };
  return { ...factories.copy({ values, utils, truncation, native }), truncation };
};
