#!/usr/bin/env python3
"""Verify complete pinned references and select the unchanged native cp walk."""
from pathlib import Path
import hashlib
import json

def sources(root):
    root = Path(root)
    m = json.loads((root / 'copy-directory-sources.json').read_text())
    if m['target'] != 'Node.js v26.13.0' or m['sourceCommit'] != '18b32a3b1552e199a01f1a8d9fd64aa756d3b75b':
        raise ValueError('Copy-directory target mismatch')
    result = {}
    for name, item in m['sources'].items():
        raw = (root / item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('Copy-directory reference mismatch: ' + name)
        result[name] = raw.decode()
    return result

def select(source, start, end):
    if source.count(start) != 1 or source.count(end) != 1:
        raise ValueError('Ambiguous copy-directory source section')
    return source[source.index(start):source.index(end)]

def helpers(source):
    import re
    check = select(source, 'static void CpSyncCheckPaths(', '\nstd::vector<std::string> normalizePathToArray(')
    check = check[check.index('  std::error_code error_code;'):]
    check = check.rsplit('}', 1)[0]
    check = check.replace('return env->ThrowUVException(\n        errorno, dereference ? "stat" : "lstat", nullptr, src.out());',
                          'return CpError::Uv(errorno, dereference ? "stat" : "lstat", src_path.native());')
    kinds = {'EINVAL': 'kEinval', 'DIR_TO_NON_DIR': 'kDirToNonDir', 'NON_DIR_TO_DIR': 'kNonDirToDir',
             'SOCKET': 'kSocket', 'FIFO_PIPE': 'kFifo', 'UNKNOWN': 'kUnknown'}
    def coded(match):
        name, arguments = match.groups()
        kind = 'kIsDir' if name == 'EISDIR' else kinds[name[3:]]
        return 'return {CpError::' + kind + ', 0, "cp", SPrintF(message, ' + arguments + ')};'
    check = re.sub(r'return THROW_ERR_FS_(CP_[A-Z_]+|EISDIR)\(\s*env, message, ([^;]+?)\);', coded, check)
    if 'env->' in check or 'THROW_' in check or 'src.out' in check:
        raise ValueError('Unadapted cp preflight engine binding')
    check = 'CpError CheckPaths(const std::filesystem::path& src_path, const std::filesystem::path& dest_path, bool dereference, bool recursive) {\n' + check + '  return {};\n}\n'
    override = select(source, 'static void CpSyncOverrideFile(', '\nstatic void CpSyncCopyDir(')
    override = override[override.index('  std::error_code error;'):].rsplit('}', 1)[0]
    override = override.replace('return env->ThrowStdErrException(error, "unlink", *dest);',
        'return {CpError::kErrno, error.value(), "unlink", error.message(), dest_path.native()};')
    override = override.replace('return env->ThrowStdErrException(error, "cp", *dest);',
        'return CpError::Std(error, dest_path.native());')
    override = override.replace('uv_fs_copyfile(nullptr, &req, *src, *dest, mode, nullptr)',
        'uv_fs_copyfile(nullptr, &req, src_path.c_str(), dest_path.c_str(), mode, nullptr)')
    override = override.replace('return env->ThrowUVException(result, "cp", nullptr, *src, *dest);',
        'return {CpError::kUv, result, "cp", {}, src_path.native(), dest_path.native()};')
    override = override.replace('error.Throw(env);', 'return error;')
    if 'env' in override or '*src' in override or '*dest' in override:
        raise ValueError('Unadapted cp override engine binding')
    override = 'CpError OverrideFile(const std::filesystem::path& src_path, const std::filesystem::path& dest_path, int mode, bool preserve_timestamps) {\n' + override + '  return {};\n}\n'
    return check + override

def native(root):
    s = sources(root)['src/node_file.cc']
    normalize = select(s, 'std::vector<std::string> normalizePathToArray(', '\nnamespace {\n\n// An fs.cp error')
    walk = select(s, 'CpError CopyUtimes(', '\n}  // namespace\n\nstatic void CpSyncOverrideFile')
    types = select(walk, 'struct CpDirOptions {', '\nCpError CopyFileFresh(')
    walk = walk.replace(types, '')
    return {'core': '// Unchanged selected Node.js v26.13.0 algorithms. See full reference manifest.\n' + normalize + walk + helpers(s), 'types': types}

def javascript(root):
    root = Path(root)
    s = sources(root)
    fs, promises, utils = s['lib/fs.js'], s['lib/internal/fs/promises.js'], s['lib/internal/fs/utils.js']
    validators = select(utils, '// The access modes can be any of F_OK', '// Most platforms don\'t allow reads')
    validators += select(utils, 'const defaultCpOptions = {', 'const defaultRmOptions = {')
    validators += select(utils, 'const validateCpOptions = hideStackFrames(', 'const validateRmOptions = hideStackFrames(')
    validators += select(utils, 'const getValidMode = hideStackFrames(', 'const validateStringAfterArrayBufferView = hideStackFrames(')
    factories = []
    for name in ['internal/fs/cp/cp', 'internal/fs/cp/cp-sync']:
        text = s['lib/' + name + '.js']
        if name == 'internal/fs/cp/cp':
            needle = '        ErrorCaptureStackTrace(err, copyDirNative);'
            if text.count(needle) != 1:
                raise ValueError('Review cp native rejection stack capture')
            text = text.replace(needle, '        if (ErrorCaptureStackTrace !== undefined) ErrorCaptureStackTrace(err, copyDirNative);')
        factories.append(json.dumps(name) + ': function(module, exports, require, primordials, internalBinding, process) {\n' + text + '\n}')
    sections = {
        'VALIDATORS': validators,
        'MODULES': ',\n'.join(factories),
        'LAZY': select(fs, 'function lazyLoadCp() {', 'function lazyLoadRimraf() {'),
        'MAKE_CALLBACK': select(fs, 'function makeCallback(cb) {', '// Special case of `makeCallback()`'),
        'PUBLIC': select(fs, 'function cp(src, dest, options, callback) {', 'function lazyLoadStreams() {'),
        'PROMISE_LAZY': select(promises, 'function lazyLoadCpPromises() {', '// Lazy loaded to avoid circular dependency.'),
        'PROMISE': select(promises, 'async function cp(src, dest, options) {', 'async function copyFile(src, dest, mode) {'),
    }
    adapter = (root / 'copy-directory-platform-adapter.js').read_text()
    for name, text in sections.items():
        marker = '/* NODE_COPY_DIRECTORY_' + name + ' */'
        if adapter.count(marker) != 1:
            raise ValueError('Missing cp marker: ' + name)
        adapter = adapter.replace(marker, text)
    return adapter

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--native-output', type=Path)
    parser.add_argument('--javascript-output', type=Path)
    args = parser.parse_args()
    value = native(Path(__file__).resolve().parent)
    if args.native_output:
        args.native_output.mkdir(parents=True, exist_ok=True)
        for name, text in value.items():
            (args.native_output / ('kandelo-node-copy-directory-' + name + '.inc')).write_text(text)
    if args.javascript_output:
        args.javascript_output.parent.mkdir(parents=True, exist_ok=True)
        args.javascript_output.write_text(javascript(Path(__file__).resolve().parent))
    if not args.native_output and not args.javascript_output:
        print(javascript(Path(__file__).resolve().parent), end='')
