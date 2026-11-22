#ifndef KANDELO_NODE_BUILTIN_SOURCE_REGISTRY_H
#define KANDELO_NODE_BUILTIN_SOURCE_REGISTRY_H

#include <cstddef>
#include <optional>
#include <string_view>

namespace kandelo::node {

// All views borrow immutable generated storage for the program's lifetime.
// They are source identities, not evidence that a builtin is executable.
struct BuiltinSourceView {
  const char* id;
  const char* sourcePath;
  const unsigned char* utf8;
  std::size_t length;
  const char* diagnosticFilename;
  const char* kindName;
  const char* const* parameters;
  std::size_t parameterCount;
};

std::size_t BuiltinSourceCount();
std::optional<BuiltinSourceView> BuiltinSourceAt(std::size_t index);
std::optional<BuiltinSourceView> FindBuiltinSource(std::string_view id);

}  // namespace kandelo::node

#endif  // KANDELO_NODE_BUILTIN_SOURCE_REGISTRY_H
