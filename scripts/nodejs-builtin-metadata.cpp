// Build-time metadata only: execute the pinned upstream classification and
// parameter map instead of copying their policy into a second implementation.
// This tool emits logical source metadata, never host ABI/layout/capabilities.
#include "builtin_info.h"

#include <iostream>
#include <string>

int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    const auto separator = line.find('\t');
    if (separator == std::string::npos || separator == 0 ||
        separator + 1 == line.size() ||
        line.find('\t', separator + 1) != std::string::npos ||
        line.find('\r') != std::string::npos) {
      std::cerr << "Expected one builtin ID and source path separated by a tab\n";
      return 1;
    }
    const auto id = line.substr(0, separator);
    const auto path = line.substr(separator + 1);
    const auto kind = ::node::builtins::GetBuiltinSourceType(id, path);
    const auto parameters = ::node::builtins::BuiltinInfo::parameter_map.find(kind);
    if (kind != ::node::builtins::BuiltinSourceType::kSourceTextModule &&
        parameters == ::node::builtins::BuiltinInfo::parameter_map.end()) {
      std::cerr << "Upstream builtin kind has no parameter contract\n";
      return 1;
    }
    std::cout << id << '\t' << path << '\t'
              << ::node::builtins::GetBuiltinSourceTypeName(kind) << '\t';
    if (parameters != ::node::builtins::BuiltinInfo::parameter_map.end()) {
      bool first = true;
      for (const auto& name : parameters->second) {
        if (!first) std::cout << ',';
        first = false;
        std::cout << name;
      }
    }
    std::cout << '\n';
    if (!std::cout) {
      std::cerr << "Failed writing builtin metadata\n";
      return 1;
    }
  }
  if (!std::cin.eof()) {
    std::cerr << "Failed reading builtin metadata input\n";
    return 1;
  }
  std::cout.flush();
  if (!std::cout) {
    std::cerr << "Failed flushing builtin metadata output\n";
    return 1;
  }
  return 0;
}
