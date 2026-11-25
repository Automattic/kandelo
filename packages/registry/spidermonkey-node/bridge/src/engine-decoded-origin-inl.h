#ifndef KANDELO_NODE_ENGINE_DECODED_ORIGIN_INL_H
#define KANDELO_NODE_ENGINE_DECODED_ORIGIN_INL_H

#include "frontend/SourceNotes.h"
#include "frontend/TokenStream.h"

// Bridge-owned cache-origin adaptation. This intentionally uses the pinned
// private frontend metadata API; update it with the engine, and qualify all
// source-note forms, nested/lazy scripts and module entries on upgrades.
// The mapping algorithm is unchanged from the former embedding engine patch.
namespace v8::decoded_origin {
using namespace js;
using namespace js::frontend;

class DecodedOriginMap {
  JSContext* cx_;
  uint32_t firstLine_;
  int64_t lineDelta_, columnDelta_;

 public:
  DecodedOriginMap(JSContext* cx, ScriptSource* source,
                   const JS::ReadOnlyCompileOptions& options)
      : cx_(cx), firstLine_(source->startLine()),
        lineDelta_(int64_t(options.lineno) - source->startLine()),
        columnDelta_(int64_t(options.column.oneOriginValue()) -
                     source->startColumn().oneOriginValue()) {}

  bool changesColumns() const { return columnDelta_ != 0; }

  bool line(uint32_t before, uint32_t* after) const {
    int64_t value = int64_t(before) + lineDelta_;
    if (value < 0 || value > UINT32_MAX) {
      JS_ReportErrorASCII(cx_, "Decoded source line is outside the engine range");
      return false;
    }
    *after = uint32_t(value);
    return true;
  }

  bool column(uint32_t line, uint32_t before, uint32_t* after) const {
    if (line != firstLine_ || !changesColumns()) {
      *after = before;
      return true;
    }
    // A saturated position no longer contains its original source column.
    // Do not manufacture a lower position or claim a cache hit for it.
    if (before == JS::LimitedColumnNumberOneOrigin::Limit && columnDelta_ < 0) {
      JS_ReportErrorASCII(cx_, "Full-precision decoded source columns are not connected");
      return false;
    }
    int64_t value = int64_t(before) + columnDelta_;
    if (value < 1) {
      JS_ReportErrorASCII(cx_, "Decoded source column has no valid origin mapping");
      return false;
    }
    *after = uint32_t(std::min<int64_t>(
        value, JS::LimitedColumnNumberOneOrigin::Limit));
    return true;
  }
};

bool RebaseDecodedNotes(FrontendContext* fc, const DecodedOriginMap& map,
                         const SourceExtent& extent, ImmutableScriptData* data,
                         Vector<SrcNote, 0, SystemAllocPolicy>& output) {
  auto allocate = [&](size_t count) -> SrcNote* {
    size_t start = output.length();
    if (!output.growBy(count)) {
      ReportOutOfMemory(fc);
      return nullptr;
    }
    return output.begin() + start;
  };
  uint32_t line = extent.lineno;
  uint32_t oldColumn = extent.column.oneOriginValue(), newColumn;
  if (!map.column(line, oldColumn, &newColumn)) {
    return false;
  }
  ptrdiff_t delta = 0;
  for (SrcNoteIterator it(data->notes(), data->notes() + data->noteLength());
       !it.atEnd(); ++it) {
    const SrcNote* note = *it;
    delta += note->delta();
    if (note->type() == SrcNoteType::XDelta) {
      continue;
    }
    ptrdiff_t operands[2] = {};
    MOZ_RELEASE_ASSERT(SrcNoteReader::arity(note) <= 2);
    for (unsigned i = 0; i < SrcNoteReader::arity(note); ++i) {
      operands[i] = SrcNoteReader::getOperand(note, i);
    }
    switch (note->type()) {
      case SrcNoteType::ColSpan: {
        oldColumn = uint32_t(int64_t(oldColumn) +
            SrcNote::ColSpan::getSpan(note).value());
        uint32_t target;
        if (!map.column(line, oldColumn, &target)) {
          return false;
        }
        operands[0] = SrcNote::ColSpan::toOperand(
            JS::ColumnNumberOffset(int32_t(target) - int32_t(newColumn)));
        newColumn = target;
        break;
      }
      case SrcNoteType::NewLine:
        ++line;
        oldColumn = newColumn = 1;
        break;
      case SrcNoteType::NewLineColumn:
        ++line;
        oldColumn = uint32_t(operands[0]);
        if (!map.column(line, oldColumn, &newColumn)) {
          return false;
        }
        operands[0] = newColumn;
        break;
      case SrcNoteType::SetLine:
        line = extent.lineno + uint32_t(operands[0]);
        oldColumn = newColumn = 1;
        break;
      case SrcNoteType::SetLineColumn:
        line = extent.lineno + uint32_t(operands[0]);
        oldColumn = uint32_t(operands[1]);
        if (!map.column(line, oldColumn, &newColumn)) {
          return false;
        }
        operands[1] = newColumn;
        break;
      default:
        break;
    }
    if (!SrcNoteWriter::writeNote(note->type(), delta, allocate)) {
      return false;
    }
    delta = 0;
    for (unsigned i = 0; i < SrcNoteReader::arity(note); ++i) {
      if (!SrcNoteWriter::writeOperand(operands[i], allocate)) {
        return false;
      }
    }
  }
  MOZ_ASSERT(delta == 0);
  if (!output.append(SrcNote::padding())) {
    ReportOutOfMemory(fc);
    return false;
  }
  return true;
}
already_AddRefed<JS::Stencil> RebaseDecodedStencilOrigin(
    JSContext* cx, already_AddRefed<JS::Stencil> decoded,
    const JS::ReadOnlyCompileOptions& options) {
  RefPtr<JS::Stencil> input(std::move(decoded));
  MOZ_RELEASE_ASSERT(input && !JS::StencilIsBorrowed(input));
  AutoReportFrontendContext fc(cx);
  TokenStreamAnyChars optionCheck(&fc, options, nullptr);
  if (!optionCheck.checkOptions()) {
    return nullptr;
  }
  const auto* original = input->getInitial();
  DecodedOriginMap map(cx, original->source, options);
  auto editable = fc.getAllocator()->make_unique<ExtensibleCompilationStencil>(
      original->source);
  if (!editable || !editable->cloneFrom(&fc, *original)) {
    return nullptr;
  }
  if (map.changesColumns()) {
    SharedDataContainer replacement;
    size_t count = 0;
    for (size_t i = 0; i < original->scriptData.size(); ++i) {
      if (original->sharedData.get(ScriptIndex(i))) {
        ++count;
      }
    }
    if (!replacement.prepareStorageFor(&fc, count, original->scriptData.size())) {
      return nullptr;
    }
    for (size_t i = 0; i < original->scriptData.size(); ++i) {
      auto index = ScriptIndex(i);
      auto* shared = original->sharedData.get(index);
      if (!shared) {
        continue;
      }
      auto* old = shared->get();
      Vector<SrcNote, 0, SystemAllocPolicy> notes;
      if (!RebaseDecodedNotes(&fc, map, original->scriptExtra[i].extent, old,
                              notes)) {
        return nullptr;
      }
      auto data = ImmutableScriptData::new_(
          &fc, old->mainOffset, old->nfixed, old->nslots, old->bodyScopeIndex,
          old->numICEntries, original->scriptData[i].isFunction(), old->funLength,
          old->propertyCountEstimate, old->codeSpan(),
          mozilla::Span<const SrcNote>(notes.begin(), notes.length()),
          old->resumeOffsets(), old->scopeNotes(), old->tryNotes());
      if (!data) {
        return nullptr;
      }
      RefPtr<SharedImmutableScriptData> rewritten =
          SharedImmutableScriptData::createWith(&fc, std::move(data));
      if (!rewritten || !replacement.addAndShare(&fc, index, rewritten)) {
        return nullptr;
      }
    }
    std::swap(editable->sharedData, replacement);
  }
  for (auto& extra : editable->scriptExtra) {
    auto& extent = extra.extent;
    uint32_t line, column;
    if (!map.line(extent.lineno, &line) ||
        !map.column(extent.lineno, extent.column.oneOriginValue(), &column)) {
      return nullptr;
    }
    extent.lineno = line;
    extent.column = JS::LimitedColumnNumberOneOrigin(column);
  }
  if (editable->moduleMetadata) {
    auto& metadata = *editable->moduleMetadata;
    for (auto* entries : {&metadata.requestedModules, &metadata.importEntries,
                         &metadata.localExportEntries,
                         &metadata.indirectExportEntries,
                         &metadata.starExportEntries}) {
      for (auto& entry : *entries) {
        if (!entry.lineno) {
          continue;
        }
        uint32_t line, column;
        if (!map.line(entry.lineno, &line) ||
            !map.column(entry.lineno, entry.column.oneOriginValue(), &column)) {
          return nullptr;
        }
        entry.lineno = line;
        entry.column = JS::ColumnNumberOneOrigin(column);
      }
    }
  }
  if (!editable->source->resetDecodedOrigin(&fc, options)) {
    return nullptr;
  }
  RefPtr<CompilationStencil> initial =
      fc.getAllocator()->new_<CompilationStencil>(std::move(editable));
  if (!initial) {
    return nullptr;
  }
  RefPtr<JS::Stencil> result =
      fc.getAllocator()->new_<InitialStencilAndDelazifications>();
  if (!result || !result->init(&fc, initial)) {
    return nullptr;
  }
  return result.forget();
}



}  // namespace v8::decoded_origin

#endif
