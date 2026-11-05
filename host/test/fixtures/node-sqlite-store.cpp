#include "sqlite-store.h"
#include <cassert>
#include <iostream>
#include <sstream>
using namespace kandelo::sqlite;
static Cell Int(int64_t number) { Cell cell; cell.type = SQLITE_INTEGER; cell.integer = number; return cell; }
static Cell Text(std::string text) { Cell cell; cell.type = SQLITE_TEXT; cell.text = std::move(text); return cell; }
static std::string Hex(const void* data, size_t size) {
  const auto* bytes = static_cast<const unsigned char*>(data);
  const char* digits = "0123456789abcdef";
  std::string result;
  for (size_t i = 0; i < size; ++i) { result += digits[bytes[i] >> 4]; result += digits[bytes[i] & 15]; }
  return result;
}
static std::vector<Cell> Get(std::shared_ptr<Connection> db, const std::string& sql) {
  auto statement = db->Prepare(sql);
  assert(statement->Step()); auto row = statement->Row(); statement->Reset(); return row;
}
int main(int argc, char** argv) {
  assert(argc == 2);
  auto db = std::make_shared<Connection>(":memory:", Options{}); db->Open();
  const auto foreignKeys = Get(db, "PRAGMA foreign_keys")[0].integer;
  bool dqs = false;
  try { db->Prepare("SELECT \"missing\""); } catch (const Error& error) { dqs = error.code == "ERR_SQLITE_ERROR"; }
  db->Exec("PRAGMA writable_schema = ON");
  const auto writableSchema = Get(db, "PRAGMA writable_schema")[0].integer;
  db->Exec("CREATE TABLE t(i INTEGER, x TEXT, b BLOB, f REAL)");
  auto insert = db->Prepare("INSERT INTO t VALUES(?1,:text,?3,?4)");
  assert(insert->ParameterCount() == 4 && insert->ParameterName(2) == ":text");
  insert->Bind(1, Int(9007199254740993LL));
  insert->Bind(2, Text(std::string("\xc3\xa9\0z", 4)));
  Cell blob; blob.type = SQLITE_BLOB; blob.bytes = {0, 255, 7}; insert->Bind(3, blob);
  Cell real; real.type = SQLITE_FLOAT; real.number = 1.25; insert->Bind(4, real);
  assert(!insert->Step()); insert->Reset();
  const auto changes = db->Changes(), rowid = db->LastInsertRowid();
  auto selected = db->Prepare("SELECT i,x,b,f FROM t");
  assert(selected->Step()); const auto typed = selected->Row(); selected->Reset();
  assert(typed[0].type == SQLITE_INTEGER && typed[1].type == SQLITE_TEXT && typed[2].type == SQLITE_BLOB && typed[3].type == SQLITE_FLOAT);
  auto empty = db->Prepare("SELECT typeof(?),length(?)");
  Cell emptyBlob; emptyBlob.type = SQLITE_BLOB;
  empty->Bind(1, emptyBlob); empty->Bind(2, emptyBlob); assert(empty->Step());
  const auto emptyRow = empty->Row(); empty->Reset();
  assert(emptyRow[0].text == "blob" && emptyRow[1].integer == 0);
  db->Exec("BEGIN"); const bool inTransaction = db->IsTransaction(); db->Exec("ROLLBACK");
  const bool afterRollback = db->IsTransaction();
  auto malformed = db->Prepare("INSERT INTO t(i) VALUES(?)");
  malformed->Bind(1, Int(3)); assert(!malformed->Step()); malformed->Reset(true);
  db->Exec("CREATE VIRTUAL TABLE fts USING fts5(content); INSERT INTO fts VALUES('searchable words')");
  const auto fts = Get(db, "SELECT count(*) FROM fts WHERE fts MATCH 'searchable'")[0].integer;
  const auto math = Get(db, "SELECT acos(1)")[0].number;
  bool callbackClose = false;
  { Connection::CallbackScope guard(*db); try { db->Close(); } catch (const Error& error) { callbackClose = error.code == "ERR_INVALID_STATE"; } }
  assert(callbackClose && db->IsOpen());
  db->Close(); bool invalidated = false;
  try { selected->Step(); } catch (const Error& error) { invalidated = error.code == "ERR_INVALID_STATE"; }
  assert(invalidated);
  db->Open(); const auto reopenedTables = Get(db, "SELECT count(*) FROM sqlite_master")[0].integer; db->Close();
  Options readOnly; readOnly.readOnly = true;
  auto failed = std::make_shared<Connection>(argv[1], readOnly); bool failedClosed = false;
  try { failed->Open(); } catch (const Error& error) { failedClosed = error.code == "ERR_SQLITE_ERROR" && !failed->IsOpen(); }
  assert(failedClosed);
  auto owned = std::make_shared<Connection>(":memory:", Options{}); owned->Open();
  std::weak_ptr<Connection> weak = owned; auto retained = owned->Prepare("SELECT 1"); owned.reset();
  assert(!weak.expired() && retained->Step()); retained.reset(); assert(weak.expired());
  std::cout << "{\"version\":\"" << sqlite3_libversion() << "\",\"foreignKeys\":" << foreignKeys
    << ",\"doubleQuoteDenied\":" << (dqs ? "true" : "false") << ",\"writableSchema\":" << writableSchema
    << ",\"integer\":\"" << typed[0].integer << "\",\"textHex\":\"" << Hex(typed[1].text.data(), typed[1].text.size())
    << "\",\"blobHex\":\"" << Hex(typed[2].bytes.data(), typed[2].bytes.size()) << "\",\"real\":" << typed[3].number
    << ",\"changes\":" << changes << ",\"rowid\":" << rowid << ",\"emptyBlob\":true,\"inTransaction\":" << (inTransaction ? "true" : "false")
    << ",\"afterRollback\":" << (afterRollback ? "true" : "false") << ",\"fts\":" << fts << ",\"math\":" << math
    << ",\"invalidated\":true,\"reopenedTables\":" << reopenedTables << ",\"failedOpenClosed\":true}" << std::endl;
}
