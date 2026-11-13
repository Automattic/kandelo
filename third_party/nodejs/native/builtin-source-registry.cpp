#include <algorithm>
#include <iterator>

#include "builtin-source-registry.h"

namespace kandelo::node {
namespace {

struct NodeBuiltinSourceEntry {
  const char* id;
  const char* sourcePath;
  std::size_t offset;
  std::size_t length;
  const char* diagnosticFilename;
  const char* kindName;
  const char* const* parameters;
  std::size_t parameterCount;
};

// Generated from sources.json only after every input hash has been verified.
// No JavaScript algorithms or source text are rewritten by this packaging.
#include "node-source-registry.generated.h"

BuiltinSourceView View(const NodeBuiltinSourceEntry& entry) {
  return {entry.id, entry.sourcePath, kNodeBuiltinBytes + entry.offset,
          entry.length, entry.diagnosticFilename, entry.kindName,
          entry.parameters, entry.parameterCount};
}

}  // namespace

std::size_t BuiltinSourceCount() { return std::size(kNodeBuiltinEntries); }

std::optional<BuiltinSourceView> BuiltinSourceAt(std::size_t index) {
  if (index >= BuiltinSourceCount()) {
    return std::nullopt;
  }
  return View(kNodeBuiltinEntries[index]);
}

std::optional<BuiltinSourceView> FindBuiltinSource(std::string_view id) {
  const auto* end = std::end(kNodeBuiltinEntries);
  const auto* entry = std::lower_bound(
      std::begin(kNodeBuiltinEntries), end, id,
      [](const NodeBuiltinSourceEntry& candidate, std::string_view wanted) {
        return std::string_view(candidate.id) < wanted;
      });
  if (entry == end || std::string_view(entry->id) != id) {
    return std::nullopt;
  }
  return View(*entry);
}

}  // namespace kandelo::node
