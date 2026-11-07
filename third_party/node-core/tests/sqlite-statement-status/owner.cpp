#include "sqlite-store.h"
#include <cassert>
#include <cstdio>
#include <cstring>
using namespace kandelo::sqlite;
static int groups = 0;
static void Pass(const char* name) { ++groups; std::printf("{\"case\":\"%s\",\"pass\":true}\n", name); }
static std::string ErrorOf(const std::function<void()>& action) {
  try { action(); return "none"; } catch(const Error& error) { return error.code + ":" + error.what(); }
}
struct Reentry { Statement* statement; bool passed = false; };
static void Inspect(sqlite3_context* context, int, sqlite3_value**) {
  auto* state = static_cast<Reentry*>(sqlite3_user_data(context));
  try { (void)state->statement->Stat("run"); state->statement->ResetStats(); state->passed = true; sqlite3_result_int(context, 1); }
  catch (...) { sqlite3_result_error(context, "actual status reentry failed", -1); }
}
int main() {
  auto db=std::make_shared<Connection>(":memory:",Options{});db->Open();
  db->Exec("CREATE TABLE t(x);INSERT INTO t VALUES(3),(1),(2)");
  auto scan=db->Prepare("SELECT * FROM t ORDER BY x");
  size_t count=0;for(const auto& info:kStatusMapping) { assert(scan->Stat(info.js_name)>=0);++count; }
  assert(count==9);Pass("nine-real-counters");
  assert(scan->Stat("run")==0);while(scan->Step()){}scan->Reset();
  assert(scan->Stat("run")==1 && scan->Stat("vmStep")>0 && scan->Stat("fullscanStep")>0 && scan->Stat("sort")>0);
  const int run=scan->Stat("run");assert(scan->Stat("run")==run);Pass("real-execution-and-nondestructive-read");
  const int memory=scan->Stat("memused");assert(memory>0);scan->ResetStats();
  for(const auto& info:kStatusMapping)if(info.sqlite_status_id!=SQLITE_STMTSTATUS_MEMUSED)assert(scan->Stat(info.js_name)==0);
  assert(scan->Stat("memused")==memory);Pass("reset-real-counters-preserve-memory");
  while(scan->Step()){}scan->Reset();assert(scan->Stat("run")==1);Pass("accumulate-after-reset");
  auto partial=db->Prepare("SELECT x FROM t ORDER BY x");assert(partial->Step());assert(partial->Row()[0].integer==1);
  partial->ResetStats();assert(partial->Step());assert(partial->Row()[0].integer==2);partial->Reset();Pass("reset-does-not-rewind-live-vm");
  auto other=db->Prepare("SELECT 2");while(other->Step()){}other->Reset();const int steps=other->Stat("vmStep");scan->ResetStats();assert(other->Stat("vmStep")==steps);Pass("independent-statements");
  assert(ErrorOf([&]{scan->Stat("not-a-counter");})=="ERR_INVALID_ARG_VALUE:The \"counter\" argument is not a valid statistic name.");
  assert(ErrorOf([&]{scan->Stat(std::string("run\0extra",9));}).find("ERR_INVALID_ARG_VALUE:")==0);Pass("unknown-and-embedded-null-names");
  Reentry reentry{};assert(sqlite3_create_function_v2(db->Require(),"inspect",0,SQLITE_UTF8,&reentry,Inspect,nullptr,nullptr,nullptr)==SQLITE_OK);
  auto callback=db->Prepare("SELECT inspect()");reentry.statement=callback.get();assert(callback->Step());assert(reentry.passed);callback->Reset();Pass("actual-active-callback-status-reset");
  auto schema=db->Prepare("SELECT * FROM t");db->Exec("ALTER TABLE t RENAME COLUMN x TO y");while(schema->Step()){}schema->Reset();schema->ResetStats();db->Exec("ALTER TABLE t RENAME COLUMN y TO z");assert(schema->Step());assert(schema->ColumnName(0)=="z");schema->Reset();Pass("live-column-names-after-reprepare-and-reset");
  scan->Close();assert(ErrorOf([&]{scan->Stat("invalid");})=="ERR_INVALID_STATE:statement has been finalized");assert(ErrorOf([&]{scan->ResetStats();})=="ERR_INVALID_STATE:statement has been finalized");Pass("finalized-priority");
  db->Close();assert(ErrorOf([&]{other->Stat("run");})=="ERR_INVALID_STATE:statement has been finalized");Pass("database-close-finalizes-counter-owner");
  std::printf("{\"groups\":%d,\"sqlite\":\"%s\"}\n",groups,sqlite3_libversion());
}
