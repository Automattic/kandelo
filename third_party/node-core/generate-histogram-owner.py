#!/usr/bin/env python3
"""Extract the pinned Node histogram algorithms; never fetch or upgrade source.

The generated owner excludes V8, libuv handles, JS error construction and job
delivery. The small portability header owns the lock, clock and invariant hooks.
"""
from pathlib import Path
import hashlib
import json
import sys

root = Path(__file__).resolve().parent
ref = root / 'upstream/histogram-reference'
identity = json.loads((root / 'histogram-source-identities.json').read_text())
target = json.loads((root.parents[1] / 'packages/registry/node-compat/target.json').read_text())
if target['version'] != identity['version'] or target['source'] != identity['source']:
    raise ValueError('Histogram owner and Node API target must retain the same pin')
for name, digest in identity['files'].items():
    if hashlib.sha256((ref / name).read_bytes()).hexdigest() != digest:
        raise ValueError('Histogram reference identity mismatch: ' + name)


def between(text, begin, end):
    return text[text.index(begin):text.index(end)]


def adapt(text):
    # Native Node uses 64-bit size_t on supported hosts. Guest wasm32 must
    # retain those observable count widths, including values above UINT32_MAX.
    text = text.replace('size_t Exceeds()', 'uint64_t Exceeds()')
    text = text.replace('size_t Count()', 'uint64_t Count()')
    text = text.replace('size_t exceeds_', 'uint64_t exceeds_')
    text = text.replace('size_t Histogram::Count()', 'uint64_t Histogram::Count()')
    text = text.replace('size_t Histogram::Exceeds()', 'uint64_t Histogram::Exceeds()')
    text = text.replace('static_cast<size_t>(histogram_->total_count)',
                        'static_cast<uint64_t>(histogram_->total_count)')
    text = text.replace('uv_hrtime()', 'clock_()')
    # Preserve pointer-ordered locking using C++'s total pointer order, which
    # is defined even when the two owners are unrelated allocations.
    text = text.replace('this < &other', 'std::less<const Histogram*>{}(this, &other)')
    # Preserve Node's always-on CHECK behavior even in NDEBUG builds.
    import re
    text = re.sub(r'CHECK_(EQ|GE|GT|LE|LT)\(([^,\n]+), ([^\n]+)\);',
                  lambda m: 'HistogramInvariant((' + m[2] + ') ' +
                  {'EQ': '==', 'GE': '>=', 'GT': '>', 'LE': '<=', 'LT': '<'}[m[1]] +
                  ' (' + m[3] + '));', text)
    text = re.sub(r'CHECK\(([^\n]+)\);', r'HistogramInvariant(static_cast<bool>(\1));', text)
    return text


notice = ('// Generated from the pinned Node.js 26.13.0 histogram owner.\n'
          '// See histogram-source-identities.json, histogram-owner.md and LICENSE.\n'
          '// Regenerate with generate-histogram-owner.py; do not edit here.\n')
header = (ref / 'src/histogram.h').read_text()
header = between(header, 'constexpr int kDefaultHistogramFigures', '\nclass HistogramImpl')
header = header.replace('class Histogram : public MemoryRetainer', 'class Histogram')
header = header.replace('DeleteFnPtr<hdr_histogram, hdr_close>',
                        'std::unique_ptr<hdr_histogram, HistogramDeleter>')
header = header.replace('  void MemoryInfo(MemoryTracker* tracker) const override;\n'
                        '  SET_MEMORY_INFO_NAME(Histogram)\n'
                        '  SET_SELF_SIZE(Histogram)\n', '')
header = header.replace('  RwLock mutex_;',
                        '  HistogramClock clock_ = HistogramMonotonicNow;\n'
                        '  RwLock mutex_;')
# A caller-supplied clock is a portable monotonic-nanosecond capability; it is
# fixed before publication and retained by independent clones and diff owners.
header = header.replace('Create(const Options& options);',
                        'Create(const Options& options,\n'
                        '      HistogramClock clock = HistogramMonotonicNow);')
header = header.replace('Histogram(HistogramPointer histogram, const Options& options);',
                        'Histogram(HistogramPointer histogram, const Options& options,\n'
                        '            HistogramClock clock = HistogramMonotonicNow);')
# Accounting belongs to actual native material, not each JS alias. It survives
# cache publication/invalidation, clone queues and context retirement.
header = header.replace('    int64_t total_count = 0;\n  };',
    '    int64_t total_count = 0;\n'
    '    memory::Allocation retained{sizeof(RecordedSnapshot)};\n  };', 1)
header = header.replace('    bool cache_hit = false;',
    '    bool cache_hit = false;\n    memory::Allocation capturedHdrRetained;')
header = header.replace('  virtual ~Histogram() = default;',
    '  virtual ~Histogram() = default;\n'
    '  const memory::RecordHandle& RetainedAllocation() const { return retained_.Handle(); }')
header = header.replace('  HistogramClock clock_ = HistogramMonotonicNow;',
    '  memory::Allocation retained_;\n  HistogramClock clock_ = HistogramMonotonicNow;')
header = (notice + '#ifndef KANDELO_NODE_HISTOGRAM_OWNER_H_\n'
          '#define KANDELO_NODE_HISTOGRAM_OWNER_H_\n'
          '#include "histogram-portability.h"\n'
          'namespace kandelo::histogram {\n' + adapt(header) +
          '}  // namespace kandelo::histogram\n'
          '#endif\n')

inl = between((ref / 'src/histogram-inl.h').read_text(),
              'void Histogram::UpdateEwma', '}  // namespace node')
inl = (notice + '#ifndef KANDELO_NODE_HISTOGRAM_OWNER_INL_H_\n'
       '#define KANDELO_NODE_HISTOGRAM_OWNER_INL_H_\n'
       '#include "histogram-owner.h"\n'
       'namespace kandelo::histogram {\n' + adapt(inl) +
       '}  // namespace kandelo::histogram\n#endif\n')

source = (ref / 'src/histogram.cc').read_text()
core = between(source, 'Histogram::Histogram(', 'HistogramImpl::HistogramImpl(')
core = core.replace(between(core, 'void Histogram::MemoryInfo(',
                             'bool Histogram::IsCompatible('), '')
# Keep the exact QRDE numerical implementation, replacing only the V8 result
# conversion/job with a public portable numerical entrypoint below.
qrde_types = between(core, 'struct QrdeResult {', 'static bool QrdeShouldDequantize')
core = core.replace(qrde_types, '')
core = core.replace(between(core, 'static Local<Float64Array> ToFloat64Array(',
                             '// -----------------------------------------------------------------------'), '')
core = core.replace('Histogram::Histogram(HistogramPointer histogram, const Options& options)\n'
                     '    : histogram_(std::move(histogram))',
                     'Histogram::Histogram(HistogramPointer histogram, const Options& options,\n'
                     '                     HistogramClock clock)\n'
                     '    : histogram_(std::move(histogram)), clock_(clock)')
core = core.replace('Histogram::Create(const Options& options)',
                     'Histogram::Create(const Options& options, HistogramClock clock)')
core = core.replace('HistogramPointer(histogram), options);',
                     'HistogramPointer(histogram), options, clock);')
core = core.replace('HistogramPointer(histogram), Options{});',
                     'HistogramPointer(histogram), Options{}, clock_);')
core = core.replace('  // alpha = 1 - 2^(-1/halfLife).',
    '  retained_.Resize(sizeof(*this) + hdr_get_memory_size(histogram_.get()));\n'
    '  // alpha = 1 - 2^(-1/halfLife).', 1)
# Account the built vector capacity, including native worker construction.
begin = core.index('Histogram::RecordedSnapshot Histogram::BuildRecordedSnapshot(')
end = core.index('Histogram::RecordedSnapshotSource Histogram::GetRecordedSnapshotSource(', begin)
recorded = core[begin:end].replace('  snapshot.buckets.reserve(occupied);',
    '  snapshot.buckets.reserve(occupied);\n  snapshot.retained.Resize(sizeof(RecordedSnapshot) + snapshot.buckets.capacity() * sizeof(RecordedBucket));').replace('return snapshot;',
    'snapshot.retained.Resize(sizeof(RecordedSnapshot) + snapshot.buckets.capacity() * sizeof(RecordedBucket)); return snapshot;')
# The empty fast path must keep its original conditional control flow.
recorded = recorded.replace('if (snapshot.total_count == 0) snapshot.retained.Resize(sizeof(RecordedSnapshot) + snapshot.buckets.capacity() * sizeof(RecordedBucket)); return snapshot;',
    'if (snapshot.total_count == 0) return snapshot;')
core = core[:begin] + recorded + core[end:]
core = core.replace('source.histogram.reset(copy);',
    'source.histogram.reset(copy);\n  source.capturedHdrRetained.Resize(hdr_get_memory_size(copy));')
core = core.replace('source.histogram.reset();',
    'source.histogram.reset();\n    source.capturedHdrRetained.Resize(0);')

core = (notice + '#include "histogram-owner.h"\n'
        '#include "histogram-work.h"\n'
        '#include <algorithm>\n#include <cmath>\n#include <cstring>\n'
        '#include <numbers>\n#include <vector>\n'
        '#include "histogram-owner-inl.h"\n'
        'namespace kandelo::histogram {\n' + adapt(core) +
        'QrdeResult CalculateHistogramQrde(const Histogram::RecordedSnapshot& snapshot,\n'
        '    const std::vector<double>& probabilities, QrdeDequantization mode) {\n'
        '  return CalculateQrde(snapshot, probabilities, mode);\n}\n'
        '}  // namespace kandelo::histogram\n')

window = between(source, 'uint64_t SlidingWindowHistogram::CurrentTimeGeneration()',
                 'void SlidingWindowHistogram::New(')
window = window.replace('    env()->external_memory_accounter()->Increase(env()->isolate(), size);\n', '')
window = window.replace('Histogram::Create(options_)', 'Histogram::Create(options_, clock_)')
window = (notice + '#include "histogram-window.h"\n#include <algorithm>\n'
          '#include "histogram-owner-inl.h"\n'
          'namespace kandelo::histogram {\n' + adapt(window) +
          '}  // namespace kandelo::histogram\n')

outputs = {'histogram-owner.h': header, 'histogram-owner-inl.h': inl,
           'histogram-owner.cc': core, 'histogram-window.cc': window}
for name, content in outputs.items():
    path = root / name
    if '--check' in sys.argv:
        if not path.exists() or path.read_text() != content:
            raise ValueError('Stale generated histogram owner: ' + name)
    else:
        path.write_text(content)
