// Generated from pinned Node node_dotenv.cc by generate-dotenv.py.
// Upstream Node license: third_party/node-core/LICENSE.
#ifndef KANDELO_NODE_DOTENV_PARSER_H
#define KANDELO_NODE_DOTENV_PARSER_H
#include <algorithm>
#include <map>
#include <string>
#include <string_view>
namespace kandelo::dotenv {
class Dotenv {
  std::map<std::string, std::string> store_;
 public:
  void ParseContent(std::string_view input);
  const auto& Entries() const { return store_; }
};
// Removes leading and trailing spaces from a string_view.
// Returns an empty string_view if the input is empty.
// Example:
//   trim_spaces("  hello  ") -> "hello"
//   trim_spaces("") -> ""
inline std::string_view trim_spaces(std::string_view input) {
  if (input.empty()) return "";

  auto pos_start = input.find_first_not_of(" \t\n");
  if (pos_start == std::string_view::npos) {
    return "";
  }

  auto pos_end = input.find_last_not_of(" \t\n");
  if (pos_end == std::string_view::npos) {
    return input.substr(pos_start);
  }

  return input.substr(pos_start, pos_end - pos_start + 1);
}

inline void Dotenv::ParseContent(const std::string_view input) {
  std::string lines(input);

  // Handle windows newlines "\r\n": remove "\r" and keep only "\n"
  lines.erase(std::remove(lines.begin(), lines.end(), '\r'), lines.end());

  std::string_view content = lines;
  content = trim_spaces(content);

  std::string_view key;
  std::string_view value;

  while (!content.empty()) {
    // Skip empty lines and comments
    if (content.front() == '\n' || content.front() == '#') {
      // Check if the first character of the content is a newline or a hash
      auto newline = content.find('\n');
      if (newline != std::string_view::npos) {
        // Remove everything up to and including the newline character
        content.remove_prefix(newline + 1);
      } else {
        // If no newline is found, clear the content
        content = {};
      }

      // Skip the remaining code in the loop and continue with the next
      // iteration.
      continue;
    }

    // Find the next equals sign or newline in a single pass.
    // This optimizes the search by avoiding multiple iterations.
    auto equal_or_newline = content.find_first_of("=\n");

    // If we found nothing or found a newline before equals, the line is invalid
    if (equal_or_newline == std::string_view::npos ||
        content.at(equal_or_newline) == '\n') {
      if (equal_or_newline != std::string_view::npos) {
        content.remove_prefix(equal_or_newline + 1);
        content = trim_spaces(content);
        continue;
      }
      break;
    }

    // We found an equals sign, extract the key
    key = content.substr(0, equal_or_newline);
    content.remove_prefix(equal_or_newline + 1);
    key = trim_spaces(key);

    // If the value is not present (e.g. KEY=) set it to an empty string
    if (content.empty() || content.front() == '\n') {
      store_.insert_or_assign(std::string(key), "");
      continue;
    }

    content = trim_spaces(content);

    // Skip lines with empty keys after trimming spaces.
    // Examples of invalid keys that would be skipped:
    //   =value
    //   "   "=value
    if (key.empty()) continue;

    // Remove export prefix from key and ensure proper spacing.
    // Example: export FOO=bar -> FOO=bar
    if (key.substr(0, 7) == "export ") {
      key.remove_prefix(7);
      // Trim spaces after removing export prefix to handle cases like:
      // export   FOO=bar
      key = trim_spaces(key);
    }

    // SAFETY: Content is guaranteed to have at least one character
    if (content.empty()) {
      // In case the last line is a single key without value
      // Example: KEY= (without a newline at the EOF)
      store_.insert_or_assign(std::string(key), "");
      break;
    }

    // Expand new line if \n it's inside double quotes
    // Example: EXPAND_NEWLINES = 'expand\nnew\nlines'
    if (content.front() == '"') {
      auto closing_quote = content.find(content.front(), 1);
      if (closing_quote != std::string_view::npos) {
        value = content.substr(1, closing_quote - 1);
        std::string multi_line_value = std::string(value);

        // Replace \n with actual newlines in double-quoted strings
        size_t pos = 0;
        while ((pos = multi_line_value.find("\\n", pos)) !=
               std::string_view::npos) {
          multi_line_value.replace(pos, 2, "\n");
          pos += 1;
        }

        store_.insert_or_assign(std::string(key), multi_line_value);
        auto newline = content.find('\n', closing_quote + 1);
        if (newline != std::string_view::npos) {
          content.remove_prefix(newline + 1);
        } else {
          // In case the last line is a single key/value pair
          // Example: KEY=VALUE (without a newline at the EOF
          content = {};
        }
        continue;
      }
    }

    // Handle quoted values (single quotes, double quotes, backticks)
    if (content.front() == '\'' || content.front() == '"' ||
        content.front() == '`') {
      auto closing_quote = content.find(content.front(), 1);

      // Check if the closing quote is not found
      // Example: KEY="value
      if (closing_quote == std::string_view::npos) {
        // Check if newline exist. If it does, take the entire line as the value
        // Example: KEY="value\nKEY2=value2
        // The value pair should be `"value`
        auto newline = content.find('\n');
        if (newline != std::string_view::npos) {
          value = content.substr(0, newline);
          store_.insert_or_assign(std::string(key), value);
          content.remove_prefix(newline + 1);
        } else {
          // No newline - take rest of content
          value = content;
          store_.insert_or_assign(std::string(key), value);
          break;
        }
      } else {
        // Found closing quote - take content between quotes
        value = content.substr(1, closing_quote - 1);
        store_.insert_or_assign(std::string(key), value);
        auto newline = content.find('\n', closing_quote + 1);
        if (newline != std::string_view::npos) {
          // Use +1 to discard the '\n' itself => next line
          content.remove_prefix(newline + 1);
        } else {
          content = {};
        }
        // No valid data here, skip to next line
        continue;
      }
    } else {
      // Regular key value pair.
      // Example: `KEY=this is value`
      auto newline = content.find('\n');

      if (newline != std::string_view::npos) {
        value = content.substr(0, newline);
        auto hash_character = value.find('#');
        // Check if there is a comment in the line
        // Example: KEY=value # comment
        // The value pair should be `value`
        if (hash_character != std::string_view::npos) {
          value = value.substr(0, hash_character);
        }
        value = trim_spaces(value);
        store_.insert_or_assign(std::string(key), std::string(value));
        content.remove_prefix(newline + 1);
      } else {
        // Last line without newline
        value = content;
        auto hash_char = value.find('#');
        if (hash_char != std::string_view::npos) {
          value = content.substr(0, hash_char);
        }
        store_.insert_or_assign(std::string(key), trim_spaces(value));
        content = {};
      }
    }

    content = trim_spaces(content);
  }
}


}  // namespace kandelo::dotenv
#endif
