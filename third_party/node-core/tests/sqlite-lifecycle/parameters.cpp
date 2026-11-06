// Real SQLite prepare-only parameter metadata. Registered callback signatures
// are supplied by the frontend fixture; no callback body executes here.
#include "sqlite-store.h"
#include <iostream>
static void Scalar(sqlite3_context* context, int, sqlite3_value**) { sqlite3_result_null(context); }
static void Step(sqlite3_context*, int, sqlite3_value**) {}
static void Final(sqlite3_context* context) { sqlite3_result_null(context); }
int main(int argc, char** argv) {
  if (argc < 3 || (argc - 3) % 3) return 2;
  try {
    auto db = std::make_shared<kandelo::sqlite::Connection>(argv[1], kandelo::sqlite::Options{}); db->Open();
    for (int i = 3; i < argc; i += 3) {
      const int arity = std::stoi(argv[i + 2]);
      const int result = std::string(argv[i]) == "scalar" ?
          sqlite3_create_function_v2(db->Require(), argv[i + 1], arity, SQLITE_UTF8, nullptr, Scalar, nullptr, nullptr, nullptr) :
          sqlite3_create_window_function(db->Require(), argv[i + 1], arity, SQLITE_UTF8, nullptr, Step, Final, Final, Step, nullptr);
      if (result != SQLITE_OK) throw kandelo::sqlite::DatabaseError(db->Require(), result);
    }
    auto statement = db->Prepare(argv[2]); std::cout << '[';
    for (int i = 1; i <= statement->ParameterCount(); ++i) {
      if (i != 1) std::cout << ','; std::cout << '"';
      for (unsigned char c : statement->ParameterName(i)) {
        const char* hex="0123456789abcdef";
        std::cout << "\\u00" << hex[c >> 4] << hex[c & 15];
      }
      std::cout << '"';
    }
    std::cout << ']' << std::endl;
  } catch (const std::exception& error) { std::cerr << error.what() << std::endl; return 1; }
}
