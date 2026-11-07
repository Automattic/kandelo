'use strict';
// Actual generated record factories and bootstrap loader; native VM, URL,
// filesystem/environment/brands are explicit control boundaries, not a guest.
const fs = require('node:fs'), path = require('node:path'), util = require('node:util');
const vm = require('node:vm'), nodeModule = require('node:module');
const root = path.resolve(__dirname, '../../..');
const bundle = fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'packages/registry/node-compat/bootstrap.js'), 'utf8');
const factories = Function(bundle + ';return { values:_createNodeValuesPlatform, records:_createNodeModuleRecords, packages:_createNodePackageReader, policy:_createNodePackagePolicy, builtins:_createNodeBuiltinPolicy, sourceMap:_createNodeSourceMapPlatform, syntax:_createNodeModuleSyntax };')();
const a = source.indexOf('const _nodeModuleURLHref =');
const b = source.indexOf('// Natural shutdown retains', a);
if (a < 0 || b < a) throw Error('Missing actual module source boundaries');
exports.create = function create(options = {}) {
  const files = options.files;
  const warnings = [];
  const processBoundary = { platform: process.platform, execPath: process.execPath, moduleLoadList: process.moduleLoadList,
    env: process.env, cwd: () => options.cwd || process.cwd(), mainModule: undefined,
    emitWarning: (...args) => warnings.push(args) };
  const values = factories.values({ process: processBoundary, Buffer, util, inspection: util,
    signals: require('node:os').constants.signals, os: require('node:os'), getDOMException: () => DOMException });
  values.require('internal/util/debuglog').initializeDebugEnv(process.env.NODE_DEBUG);
  const read = name => {
    if (!files) return fs.readFileSync(name, 'utf8');
    if (Object.hasOwn(files, name)) return files[name];
    throw Object.assign(Error('Missing control fixture file'), { code: 'ENOENT', path: name });
  };
  const stat = name => {
    if (files) {
      if (Object.hasOwn(files, name)) return [{ mode: 0o100644 }, 0];
      if (Object.keys(files).some(file => file.startsWith(name.replace(/\/$/, '') + '/'))) return [{ mode: 0o040755 }, 0];
      return [{ mode: 0 }, -2];
    }
    try { return [fs.statSync(name), 0]; } catch (error) { return [null, error.errno]; }
  };
  const builtinModules = {};
  for (const id of nodeModule.builtinModules) {
    if (!id.startsWith('node:') && id !== 'module' && id !== 'process') Object.defineProperty(builtinModules, id, {
      enumerable: true, configurable: true, get: () => require('node:' + id) });
  }
  // Controls may install an actual production builtin owner without delegating
  // that module to the embedding Node's builtin table.
  if (options.configureBuiltins) options.configureBuiltins(builtinModules, processBoundary, values);
  const context = vm.createContext({ path, Buffer, TextDecoder, TextEncoder, process: processBoundary, fs: { ...fs, readFileSync: read, realpathSync: name => files ? name : fs.realpathSync(name) },
    url: require('node:url'), _nodeWebPlatform: { URL }, _nodeValues: values,
    _nodeFsTruncation: { vfsState: { handlers: null } },
    _createNodeModuleRecords: factories.records, _createNodePackageReader: factories.packages,
    _createNodePackagePolicy: factories.policy, _createNodeSourceMapPlatform: factories.sourceMap,
    _createNodeModuleSyntax: factories.syntax,
    _nodeFsStats: { getValidatedPath: require('internal/fs/utils').getValidatedPath },
    _nodeUv: { getSystemErrorMessage: util.getSystemErrorMessage },
    _throwErrno(errno, syscall, name) { throw new values.errors.UVException({errno:-errno, code:util.getSystemErrorName(-errno),syscall,path:name}); }, _createNodeBuiltinPolicy: factories.builtins,
    _builtinModules: builtinModules,
    os: { stat, realpath(name) { try { return [files ? name : fs.realpathSync(name), 0]; } catch (e) { return [null, e.errno]; } } },
    std: { loadFile(name) { try { return read(name); } catch (_) { return null; } } },
    _nodeNative: {
      cliOptions: { conditions: options.conditions || [], packageMapPath: options.packageMapPath, preserveSymlinks: options.preserveSymlinks === true, preserveSymlinksMain: options.preserveSymlinksMain === true },
      packageOperation: require('./node-package-boundary.cjs').create(read),
      environment(operation, name) {
        if (operation !== 'safeget') throw Error('Unexpected environment action');
        if (process.getuid?.() !== process.geteuid?.() || process.getgid?.() !== process.getegid?.()) return undefined;
        return process.env[name];
      },
      moduleSyntax(operation, code, filename) {
        if (operation === 'detect') return require('internal/test/binding').internalBinding('contextify').containsModuleSyntax(code, filename);
        if (operation === 'wrap') return vm.runInContext(code, context, { filename });
        if (operation === 'compile') return vm.compileFunction(code,
          ['exports', 'require', 'module', '__filename', '__dirname'], {filename, parsingContext:context});
        throw Error('Unexpected parser boundary operation');
      },
      evalScriptAsFunction(code, filename) { return vm.runInContext(code, context, { filename }); },
      __kandeloRequireModule(name) { throw Error('Native ESM bridge is outside this CJS control: ' + name); },
    },
  });
  const api = vm.runInContext(source.slice(a, b) + ';({Module,make:_makeRequire,load:_loadCommonJsModule,syntax:_nodeModuleSyntax,looksLikeEsm:_looksLikeEsmMain});', context);
  let resolveESM;
  // A focused CJS/builtin control need not initialize the separately owned
  // native ESM graph. Its default control remains the complete resolver path.
  if (!options.skipESMResolver) {
    const resolveStart = source.indexOf('globalThis.__kandeloResolveBare =');
    const resolveEnd = source.indexOf('// The native ES-module metadata hook', resolveStart);
    if (resolveStart < 0 || resolveEnd < resolveStart) throw Error('Missing actual engine resolver source');
    vm.runInContext(source.slice(resolveStart, resolveEnd), context);
    resolveESM = vm.runInContext('__kandeloResolveBare', context);
  }
  return { ...api, resolveESM: (specifier, parent) => resolveESM(specifier, parent, true), proc: processBoundary, files, warnings, context };
};
