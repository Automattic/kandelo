std::vector<std::string> ParseNodeOptionsEnvVar(
    const std::string& node_options, std::vector<std::string>* errors) {
  std::vector<std::string> env_argv;

  bool is_in_string = false;
  bool will_start_new_arg = true;
  for (std::string::size_type index = 0; index < node_options.size(); ++index) {
    char c = node_options.at(index);

    // Backslashes escape the following character
    if (c == '\\' && is_in_string) {
      if (index + 1 == node_options.size()) {
        errors->push_back("invalid value for NODE_OPTIONS "
                          "(invalid escape)\n");
        return env_argv;
      } else {
        c = node_options.at(++index);
      }
    } else if (c == ' ' && !is_in_string) {
      will_start_new_arg = true;
      continue;
    } else if (c == '"') {
      is_in_string = !is_in_string;
      continue;
    }

    if (will_start_new_arg) {
      env_argv.emplace_back(std::string(1, c));
      will_start_new_arg = false;
    } else {
      env_argv.back() += c;
    }
  }

  if (is_in_string) {
    errors->push_back("invalid value for NODE_OPTIONS "
                      "(unterminated string)\n");
  }
  return env_argv;
}
