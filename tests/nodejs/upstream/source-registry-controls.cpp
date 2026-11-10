// Composition control for generated storage + native lookup + original Node
// metadata. Emits framed bytes for comparison with the verified source manifest.
#include "builtin-source-registry.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>
#include <string_view>

namespace {

bool Integer(std::uint64_t value) {
  unsigned char bytes[8];
  for (unsigned i = 0; i < 8; ++i) bytes[i] = value >> (i * 8);
  return std::fwrite(bytes, 1, 8, stdout) == 8;
}

bool Bytes(const void* bytes, std::size_t size) {
  return Integer(size) && std::fwrite(bytes, 1, size, stdout) == size;
}

bool String(const char* value) { return Bytes(value, std::strlen(value)); }

}  // namespace

int main() {
  using kandelo::node::BuiltinSourceAt;
  using kandelo::node::BuiltinSourceCount;
  using kandelo::node::FindBuiltinSource;
  if (BuiltinSourceAt(BuiltinSourceCount()) ||
      BuiltinSourceAt(std::numeric_limits<std::size_t>::max()) ||
      FindBuiltinSource("<absent upstream builtin>") ||
      FindBuiltinSource(std::string_view("buffer\0suffix", 13))) {
    return 1;
  }
  if (!Integer(BuiltinSourceCount())) return 2;
  std::string_view previous;
  for (std::size_t i = 0; i < BuiltinSourceCount(); ++i) {
    const auto source = BuiltinSourceAt(i);
    if (!source || (i && !(previous < source->id))) return 3;
    previous = source->id;
    const auto found = FindBuiltinSource(source->id);
    if (!found || found->utf8 != source->utf8 ||
        found->length != source->length ||
        found->parameters != source->parameters ||
        found->parameterCount != source->parameterCount) return 4;
    if (!String(source->id) || !String(source->sourcePath) ||
        !String(source->diagnosticFilename) || !String(source->kindName) ||
        !Integer(source->parameterCount)) return 5;
    for (std::size_t p = 0; p < source->parameterCount; ++p) {
      if (!String(source->parameters[p])) return 6;
    }
    if (!Bytes(source->utf8, source->length)) return 7;
  }
  return std::fflush(stdout) == 0 ? 0 : 8;
}
