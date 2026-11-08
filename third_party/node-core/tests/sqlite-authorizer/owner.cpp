#include "sqlite-store.h"
#include <cassert>
#include <cstdio>
#include <thread>
using namespace kandelo::sqlite;
static int groups=0;
static void Pass(const char* name){++groups;std::printf("{\"case\":\"%s\",\"pass\":true}\n",name);}
static bool Rejected(const std::function<void()>& f,const char* text){try{f();return false;}catch(const Error& e){return e.code=="ERR_INVALID_STATE"&&e.what()==std::string(text);}}
int main(){
 auto db=std::make_shared<Connection>(":memory:",Options{});db->Open();
 db->Exec("CREATE TABLE t(x);INSERT INTO t VALUES(1),(2)");
 int calls=0;bool select=false,read=false;
 db->SetAuthorizer([&](int code,const char* a,const char* b,const char* schema,const char* trigger){
  ++calls;assert(db->InCallback()&&db->InAuthorizer());if(code==SQLITE_SELECT){select=true;assert(!a&&!b&&!schema&&!trigger);}if(code==SQLITE_READ){read=true;assert(std::string(a)=="t"&&std::string(b)=="x"&&std::string(schema)=="main"&&!trigger);}return SQLITE_OK;
 });
 auto stmt=db->Prepare("SELECT x FROM t");assert(select&&read&&calls==2);Pass("real-five-argument-prepare-authorization");
 db->SetAuthorizer([&](int code,const char*,const char*,const char*,const char*){return code==SQLITE_READ?SQLITE_IGNORE:SQLITE_OK;});assert(stmt->Step());assert(stmt->Row()[0].type==SQLITE_NULL);stmt->Reset();Pass("real-reprepare-ignore-read-null");
 db->SetAuthorizer([](int,const char*,const char*,const char*,const char*){return SQLITE_DENY;});bool denied=false;try{db->Prepare("SELECT 4");}catch(const Error&e){denied=e.code=="ERR_SQLITE_ERROR"&&e.errcode==SQLITE_AUTH;}assert(denied);Pass("real-deny-auth-error");
 db->Close();db->Open();denied=false;try{db->Exec("SELECT 4");}catch(const Error&e){denied=e.errcode==SQLITE_AUTH;}assert(denied);db->SetAuthorizer({});db->Exec("CREATE TABLE t(x);INSERT INTO t VALUES(1),(2)");Pass("close-open-reinstalls-and-null-clears");
 auto idle=db->Prepare("SELECT 8"),busy=db->Prepare("SELECT x FROM t");assert(busy->Step());
 auto other=std::make_shared<Connection>(":memory:",Options{});other->Open();int rejected=0;bool once=false;
 const int cachedLength = db->Limit(SQLITE_LIMIT_LENGTH);assert(cachedLength>0);
 db->SetAuthorizer([&](int,const char*,const char*,const char*,const char*){if(once)return SQLITE_OK;once=true;
  assert(db->Limit(SQLITE_LIMIT_LENGTH)==cachedLength);
  const char* message="database cannot be accessed from an authorizer callback";
  for(auto operation:std::vector<std::function<void()>>{[&]{db->Prepare("SELECT 5");},[&]{db->Exec("SELECT 5");},[&]{db->SetAuthorizer({});},[&]{db->Serialize();},[&]{db->EnableDefensive(true);},[&]{db->SetLimit(SQLITE_LIMIT_LENGTH,cachedLength-1);},[&]{busy->Step();},[&]{busy->Reset();},[&]{busy->Close();},[&]{db->CreateSession("main","");}})if(Rejected(operation,message))++rejected;
  assert(Rejected([&]{db->Close();},"database cannot be closed while in a callback"));
  idle->Close();other->Exec("SELECT 1");assert(db->IsOpen());return SQLITE_OK;
 });db->Exec("SELECT 3");assert(rejected==10&&idle->IsFinalized()&&!busy->IsFinalized());assert(db->Limit(SQLITE_LIMIT_LENGTH)==cachedLength);Pass("same-connection-writes-guarded-real-limit-read-idle-close-other-db");
 db->SetAuthorizer({});busy->Reset();
 struct Original{};Original original;db->SetAuthorizer([&](int,const char*,const char*,const char*,const char*)->int{throw &original;});bool same=false;try{db->Exec("SELECT 1");}catch(Original* value){same=value==&original;}assert(same&&!db->InAuthorizer()&&!db->InCallback());db->SetAuthorizer({});db->Exec("SELECT 1");Pass("caught-cpp-failure-rethrown-outside-sqlite-and-depth-restored");
 int backupCalls=0;db->SetAuthorizer([&](int,const char*,const char*,const char*,const char*){++backupCalls;return SQLITE_OK;});
 sqlite3* destination=nullptr;assert(sqlite3_open(":memory:",&destination)==SQLITE_OK);auto* backup=sqlite3_backup_init(destination,"main",db->Require(),"main");assert(backup);int result=0;std::thread worker([&]{result=sqlite3_backup_step(backup,-1);});worker.join();assert(result==SQLITE_DONE&&backupCalls==0);assert(sqlite3_backup_finish(backup)==SQLITE_OK);sqlite3_close(destination);Pass("actual-worker-backup-pages-do-not-enter-source-authorizer");
 db->Close();bool closed=false;try{db->SetAuthorizer({});}catch(const Error&e){closed=e.code=="ERR_INVALID_STATE"&&std::string(e.what())=="database is not open";}assert(closed);other->Close();Pass("closed-registration-liveness");
 std::printf("{\"groups\":%d,\"sqlite\":\"%s\"}\n",groups,sqlite3_libversion());
}
