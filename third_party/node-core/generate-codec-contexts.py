#!/usr/bin/env python3
"""Adapt pinned Node codec contexts to the SpiderMonkey embedding, without builds.

The vendored excerpts stay byte-identical to Node. This generator changes only
embedding types, assertions, allocator ownership and memory-inspection plumbing;
codec algorithms remain in the pinned excerpts. Generate into the resolver work
tree, never into the reviewed checkout during a package build.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re


def native_providers(root, manifest):
    item = manifest['asyncNativeProviders']
    raw = (root / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Node native provider source hash mismatch')
    if item['upstreamFileSha256'] != manifest['asyncProvider']['sha256']:
        raise ValueError('Native and Promise provider sources differ')
    names = re.findall(r'^\s+V\(([A-Z_0-9]+)\)', raw.decode(), re.M)
    if len(names) != len(set(names)) or not names or names[0] != 'NONE':
        raise ValueError('Review the pinned native provider macro')
    if names.index('PROMISE') != manifest['asyncProvider']['value']:
        raise ValueError('Promise/native provider positions differ')
    return raw.decode(), {name: index for index, name in enumerate(names)}


def generate(root):
    manifest = json.loads((root / 'sources.json').read_text())
    target = json.loads((root.parents[1] / 'packages/registry/node-compat/target.json').read_text())
    if (manifest['version'], manifest['commit']) != (target['version'], target['source']['commit']):
        raise ValueError('Codec context target/source pin differs')
    provider_source, _ = native_providers(root, manifest)

    def source(group, name):
        item = manifest[group][name]
        raw = (root / item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('Codec excerpt hash mismatch: ' + name)
        return raw.decode('utf-8')

    defaults = source('compressionNative', 'defaults')
    modes = source('compressionNative', 'modes')
    errors = source('compressionContexts', 'errors')
    types = source('compressionContexts', 'context-types')
    methods = source('compressionContexts', 'context-methods')

    def replace_count(text, old, new, count):
        if text.count(old) != count:
            raise ValueError('Review codec embedding adaptation: ' + old)
        return text.replace(old, new)

    # A real native owner supplies the custom allocator directly. Node uses
    # ContainerOf on a V8 AsyncWrap; the SM object owns its codec context instead.
    methods, substitutions = re.subn(
        r'CompressionStream<\s*(?:ZlibContext|BrotliEncoderContext|BrotliDecoderContext|'
        r'ZstdCompressContext|ZstdDecompressContext)>::AllocatorOpaquePointerForContext\(\s*this\)',
        'AllocatorOpaquePointer()', methods)
    if substitutions != 5:
        raise ValueError('Review all five context allocator ownership sites')

    for name in ['ZlibContext', 'BrotliContext', 'ZstdContext']:
        old = ('class ' + name + (' final' if name == 'ZlibContext' else '') +
               ' : public MemoryRetainer {')
        if types.count(old) != 1:
            raise ValueError('Review codec context base: ' + name)
        types = types.replace(old, old.replace('MemoryRetainer', 'CodecContext'))

    # Node's heap snapshot visitor is V8-specific. Actual codec allocations are
    # retained in our allocator ledger and reported to SM's associated-memory
    # accounting by the native handle; no no-op MemoryRetainer is supplied.
    types, removed = re.subn(r'^  SET_(?:MEMORY_INFO_NAME|SELF_SIZE|NO_MEMORY_INFO)\([^\n]*\n', '', types, flags=re.M)
    if removed != 14:
        raise ValueError('Review codec heap-snapshot declarations: ' + str(removed))
    old = '  void MemoryInfo(MemoryTracker* tracker) const override {\n    tracker->TrackField("dictionary", dictionary_);\n  }\n'
    if types.count(old) != 1:
        raise ValueError('Review dictionary inspection adapter')
    types = types.replace(old, '')
    # Preserve actual retained container storage in the owning context. Do not
    # replace the upstream algorithms or count logical vector/string lengths.
    retained = {
        'ZlibContext': 'capacity::VectorBytes(dictionary_)',
        'BrotliEncoderContext': 'capacity::Add(capacity::VectorBytes(dictionary_), capacity::VectorBytes(params_))',
        'BrotliDecoderContext': 'capacity::Add(capacity::Add(capacity::VectorBytes(dictionary_), capacity::VectorBytes(params_)), capacity::StringBytes(error_string_))',
        'ZstdCompressContext': 'capacity::Add(capacity::StringBytes(error_string_), capacity::StringBytes(error_code_string_))',
        'ZstdDecompressContext': 'capacity::Add(capacity::StringBytes(error_string_), capacity::StringBytes(error_code_string_))',
    }
    for name, expression in retained.items():
        declaration = ('class ' + name + ' final : public ' +
                       ('CodecContext' if name == 'ZlibContext' else
                        'BrotliContext' if name.startswith('Brotli') else 'ZstdContext') +
                       ' {\n public:\n')
        body = ('  size_t RetainedNativeBytes() const noexcept override {\n'
                '    return capacity::Add(sizeof(*this), ' + expression + ');\n'
                '  }\n')
        types = replace_count(types, declaration, declaration + body, 1)
    types = replace_count(types, '  Mutex mutex_;  // Protects zlib_init_done_.',
                          '  js::Mutex mutex_{js::mutexid::ShellOffThreadState};  // Protects zlib_init_done_.', 1)
    # The V8 wrapper initializes before any private method can observe strm_.
    # Our independently owned context also needs safe pre-init destruction.
    types = replace_count(types, '  z_stream strm_;', '  z_stream strm_{};', 1)
    methods = replace_count(methods, 'Mutex::ScopedLock lock(mutex_);', 'js::LockGuard<js::Mutex> lock(mutex_);', 2)
    types = replace_count(types, 'CHECK_NOT_NULL(message);', 'MOZ_RELEASE_ASSERT(message);', 1)
    methods = replace_count(methods, 'UNREACHABLE("invalid number of gzip magic number bytes read");',
                              'MOZ_CRASH("invalid number of gzip magic number bytes read");', 1)
    methods = replace_count(methods, 'UNREACHABLE();', 'MOZ_CRASH("invalid codec mode");', 2)
    methods = replace_count(methods, 'CHECK_LE(mode_, UNZIP);', 'MOZ_RELEASE_ASSERT(mode_ <= UNZIP);', 1)
    for mode in ['BROTLI_ENCODE', 'BROTLI_DECODE']:
        methods = replace_count(methods, 'CHECK_EQ(mode_, ' + mode + ');', 'MOZ_RELEASE_ASSERT(mode_ == ' + mode + ');', 1)
    methods = replace_count(methods, 'CHECK(', 'MOZ_RELEASE_ASSERT(', 7)
    for token in ['MemoryRetainer', 'MemoryTracker', 'SET_MEMORY_', 'SET_SELF_', 'SET_NO_MEMORY_',
                  'CHECK(', 'CHECK_EQ(', 'CHECK_LE(', 'UNREACHABLE(', 'CompressionStream<', 'Mutex::ScopedLock']:
        if token in types + methods:
            raise ValueError('Unadapted Node embedding dependency: ' + token)

    # Both bundled branches use the package's real custom allocator. Reject a
    # foreign NODE_BUNDLED_ZSTD setting rather than silently changing ownership.
    start = '''// Generated by third_party/node-core/generate-codec-contexts.py.
// Node codec contexts; source target: VERSION / COMMIT.
// Uncompiled source candidate; generation is not conformance evidence.
LICENSE
#ifndef shell_kandelo_node_codec_contexts_h
#define shell_kandelo_node_codec_contexts_h
#include "kandelo-node-codec-owned-capacity.h"
#include "mozilla/Assertions.h"

#include <algorithm>
#include <atomic>
#include <brotli/decode.h>
#include <brotli/encode.h>
#include <brotli/shared_dictionary.h>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#include <zlib.h>
#ifndef ZSTD_STATIC_LINKING_ONLY
#define ZSTD_STATIC_LINKING_ONLY
#endif
#include <zstd.h>
#include <zstd_errors.h>
#include "threading/LockGuard.h"
#include "threading/Mutex.h"
#include "vm/MutexIDs.h"

namespace kandelo::codecs {
'''.replace('VERSION', target['version']).replace('COMMIT', target['source']['commit'])
    start += provider_source + '''
enum class AsyncProvider : int {
#define V(name) Provider_##name,
  NODE_ASYNC_NON_CRYPTO_PROVIDER_TYPES(V)
#undef V
};
#undef NODE_ASYNC_NON_CRYPTO_PROVIDER_TYPES
'''
    license_text = (root / 'LICENSE').read_text().split('The Node.js license applies', 1)[0]
    start = start.replace('LICENSE', '/*\n' + license_text + '\n*/')
    bridge = '''
// Typed native interface: the implementation runs either on the calling thread
// for writeSync or, once implemented, on actual native workers for write.
class CodecContext {
 public:
  virtual ~CodecContext() = default;
  virtual size_t RetainedNativeBytes() const noexcept = 0;
  virtual void Close() = 0;
  virtual void DoThreadPoolWork() = 0;
  virtual void SetBuffers(const char*, uint32_t, char*, uint32_t) = 0;
  virtual void SetFlush(int) = 0;
  virtual void GetAfterWriteOffsets(uint32_t*, uint32_t*) const = 0;
  virtual CompressionError GetErrorInfo() const = 0;
  virtual CompressionError ResetStream() = 0;
  void SetAllocator(void* owner) { allocator_ = owner; }
 protected:
  void* AllocatorOpaquePointer() { MOZ_RELEASE_ASSERT(allocator_); return allocator_; }
 private:
  void* allocator_ = nullptr;
};

template <typename T, void (*Free)(T*)>
struct ContextDeleter {
  void operator()(T* value) const { if (value) Free(value); }
};
template <typename T, void (*Free)(T*)>
using DeleteFnPtr = std::unique_ptr<T, ContextDeleter<T, Free>>;

// The ledger is safe on a native worker. Only the owning JS thread may report
// its delta to the GC; allocation callbacks must never touch JS/GC state.
class CompressionStreamMemoryOwner {
 public:
  static constexpr size_t reserveSizeAndAlign =
      std::max(sizeof(size_t), alignof(max_align_t));
  static void* AllocForZlib(void* owner, uInt count, uInt size) {
    if (size && size_t(count) > SIZE_MAX / size) return nullptr;
    return AllocForBrotli(owner, size_t(count) * size);
  }
  static void* AllocForBrotli(void* owner, size_t bytes) {
    if (bytes > SIZE_MAX - reserveSizeAndAlign) return nullptr;
    const size_t total = bytes + reserveSizeAndAlign;
    auto* memory = static_cast<char*>(malloc(total));
    if (!memory) return nullptr;
    *reinterpret_cast<size_t*>(memory) = total;
    static_cast<CompressionStreamMemoryOwner*>(owner)->liveBytes_.fetch_add(total, std::memory_order_relaxed);
    return memory + reserveSizeAndAlign;
  }
  static void FreeForZlib(void* owner, void* memory) {
    if (!memory) return;
    auto* allocation = static_cast<char*>(memory) - reserveSizeAndAlign;
    const size_t total = *reinterpret_cast<size_t*>(allocation);
    const size_t before = static_cast<CompressionStreamMemoryOwner*>(owner)->liveBytes_.fetch_sub(total, std::memory_order_relaxed);
    MOZ_RELEASE_ASSERT(before >= total);
    free(allocation);
  }
  size_t LiveCodecBytes() const { return liveBytes_.load(std::memory_order_relaxed); }
 private:
  std::atomic<size_t> liveBytes_{0};
};
'''
    # CompressionError must precede the typed interface.
    marker = 'void RecordBrotliParam('
    if types.count(marker) != 1:
        raise ValueError('Review error/context declaration boundary')
    at = types.index(marker)
    declarations = types[:at] + bridge + types[at:]
    methods = methods.replace('#ifdef NODE_BUNDLED_ZSTD', '#if 1  // Pinned bundled node-codecs, with real allocation accounting.')
    # Do not retain an unused alternative allocator path in generated source.
    methods, bundled = re.subn(r'#if 1  // Pinned bundled node-codecs, with real allocation accounting\.\n(.*?)#else\n.*?#endif', r'\1', methods, flags=re.S)
    if bundled != 2:
        raise ValueError('Review bundled Zstd allocator branches')
    undef = ''.join('#undef ' + line.split()[1] + '\n' for line in defaults.splitlines() if line.startswith('#define '))
    return (start + defaults + errors + modes + declarations + methods +
            undef + '#undef ZLIB_ERROR_CODES\n#undef ZSTD_ERROR_CODES\n' +
            '}  // namespace kandelo::codecs\n#endif\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    result = generate(Path(__file__).resolve().parent)
    if args.check:
        if args.output.read_text() != result:
            raise SystemExit('Generated codec contexts are stale')
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result)
