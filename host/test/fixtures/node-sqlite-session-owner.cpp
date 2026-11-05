#define SQLITE_ENABLE_SESSION 1
#include "sqlite-store.h"
#include <cassert>
#include <iostream>
using namespace kandelo::sqlite;
static std::string Hex(const std::vector<uint8_t>& bytes) {
  std::string result; const char* digits = "0123456789abcdef";
  for (auto byte : bytes) { result += digits[byte >> 4]; result += digits[byte & 15]; }
  return result;
}
int main() {
  Options options; options.limits[SQLITE_LIMIT_COLUMN] = 8;
  auto source = std::make_shared<Connection>(":memory:", options);
  auto target = std::make_shared<Connection>(":memory:", Options{});
  source->Open(); target->Open();
  const std::string schema = "CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)";
  source->Exec(schema); target->Exec(schema);
  auto metadata = source->Prepare("SELECT id, value, id + 1 AS expression FROM t");
  const auto column = metadata->ColumnMetadata(1), expression = metadata->ColumnMetadata(2);
  assert(column[0] == "value" && column[1] == "main" && column[2] == "value" && column[3] == "t" && column[4] == "TEXT");
  assert(!expression[0] && !expression[1] && expression[2] == "expression" && !expression[3] && !expression[4]);
  assert(source->Limit(SQLITE_LIMIT_COLUMN) == 8); source->SetLimit(SQLITE_LIMIT_COLUMN, 2);
  bool denied = false; try { source->Prepare("SELECT 1,2,3"); } catch (const Error& error) { denied = error.code == "ERR_SQLITE_ERROR"; }
  assert(denied); source->SetLimit(SQLITE_LIMIT_COLUMN, 2147483647); const bool resetLimit = source->Limit(SQLITE_LIMIT_COLUMN) > 2;
  source->EnableDefensive(false);
  auto session = source->CreateSession("main", "t");
  source->Exec("INSERT INTO t VALUES(1,'one'),(2,'two'); UPDATE t SET value='second' WHERE id=2");
  const auto changeset = session->Changeset(false), patchset = session->Changeset(true);
  int filters = 0, conflicts = 0; bool closeGuard = false;
  const bool first = target->ApplyChangeset(changeset, [&](const char* name) { assert(std::string(name) == "t"); ++filters; return true; });
  const bool duplicate = target->ApplyChangeset(changeset);
  const bool replaced = target->ApplyChangeset(changeset, {}, [&](int type) { assert(type == SQLITE_CHANGESET_CONFLICT); ++conflicts; return SQLITE_CHANGESET_REPLACE; });
  bool primary = false;
  try { target->ApplyChangeset(changeset, [&](const char*) -> bool {
    try { target->Close(); } catch (const Error& error) { closeGuard = error.code == "ERR_INVALID_STATE"; }
    throw std::runtime_error("callback primary");
  }); } catch (const std::runtime_error& error) { primary = std::string(error.what()) == "callback primary"; }
  auto watch = target->CreateSession("main", "t"); std::weak_ptr<Session> weak = watch;
  bool pinned = false;
  target->ApplyChangeset(changeset, [&](const char*) { watch.reset(); pinned = !weak.expired(); return false; });
  const bool retired = weak.expired();
  session->Close(); bool closedSession = false;
  try { session->Changeset(false); } catch (const Error& error) { closedSession = error.code == "ERR_INVALID_STATE"; }
  session->Close(true); const auto remaining = source->CreateSession("main", "");
  source->SetLimit(SQLITE_LIMIT_COLUMN, 3); source->Close(); remaining->Close(true); bool closedDatabase = false;
  try { remaining->Changeset(true); } catch (const Error& error) { closedDatabase = error.code == "ERR_INVALID_STATE"; }
  source->Open(); const int reopened = source->Limit(SQLITE_LIMIT_COLUMN);
  assert(first && !duplicate && replaced && filters == 1 && conflicts == 2 && resetLimit && primary && closeGuard && pinned && retired && closedSession && closedDatabase && reopened == 3);
  std::cout << "{\"changeset\":\"" << Hex(changeset) << "\",\"patchset\":\"" << Hex(patchset)
    << "\",\"first\":true,\"duplicate\":false,\"replaced\":true,\"filters\":" << filters
    << ",\"conflicts\":" << conflicts << ",\"resetLimit\":true,\"primary\":true,\"closeGuard\":true,\"closedSession\":true,\"closedDatabase\":true,\"reopened\":" << reopened << "}\n";
}
