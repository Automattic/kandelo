#include "sqlite-store.h"
#include <cassert>
#include <iostream>
using namespace kandelo::sqlite;
static std::string Failure(const std::function<void()>& fn) {
  try { fn(); return "ok"; } catch(const Error& e) { return e.code + ":" + e.what(); }
}
struct Probe {
  std::shared_ptr<Connection> db;
  std::shared_ptr<Statement> current, other, created;
  std::vector<std::string> trace;
  bool closing = false, createWhileClosing = false;
};
static void Scalar(sqlite3_context* ctx, int, sqlite3_value**) {
  auto* probe=static_cast<Probe*>(sqlite3_user_data(ctx));
  probe->trace.push_back(Failure([&]{probe->current->Close();}));
  probe->trace.push_back(Failure([&]{probe->current->Close(true);}));
  probe->trace.push_back(Failure([&]{probe->other->Close();}));
  probe->trace.push_back(Failure([&]{probe->other->Close(true);}));
  sqlite3_result_int(ctx,42);
}
static void Step(sqlite3_context* context,int,sqlite3_value**) { (void)sqlite3_aggregate_context(context, sizeof(int)); }
static void Value(sqlite3_context* ctx) { sqlite3_result_int(ctx,1); }
static void Final(sqlite3_context* ctx) {
  auto* probe=static_cast<Probe*>(sqlite3_user_data(ctx));
  if(probe->closing){
    probe->trace.push_back(Failure([&]{probe->current->Close();}));
    probe->trace.push_back(Failure([&]{probe->current->Close(true);}));
    if(probe->createWhileClosing)probe->created=probe->db->Prepare("SELECT 99");
  }
  sqlite3_result_int(ctx,1);
}
static std::shared_ptr<Connection> Database() { auto db=std::make_shared<Connection>(":memory:",Options{});db->Open();return db; }
static void Array(const std::vector<std::string>& values){std::cout<<'[';for(size_t i=0;i<values.size();++i){if(i)std::cout<<',';std::cout<<'"'<<values[i]<<'"';}std::cout<<']';}
int main(){
  auto db=Database();auto stmt=db->Prepare("SELECT 1");stmt->Close();assert(stmt->IsFinalized());
  const auto repeat=Failure([&]{stmt->Close();});assert(repeat=="ERR_INVALID_STATE:statement has been finalized");stmt->Close(true);stmt->Close(true);db->Close();stmt->Close(true);
  Probe scalar{Database()};scalar.other=scalar.db->Prepare("SELECT 1");
  assert(sqlite3_create_function_v2(scalar.db->Require(),"probe",0,SQLITE_UTF8,&scalar,Scalar,nullptr,nullptr,nullptr)==SQLITE_OK);
  scalar.current=scalar.db->Prepare("SELECT probe()");assert(scalar.current->Step());assert(scalar.current->Row()[0].integer==42);scalar.current->Close();scalar.db->Close();
  Probe aggregate{Database()};assert(sqlite3_create_window_function(aggregate.db->Require(),"win",1,SQLITE_UTF8,&aggregate,Step,Final,Value,Step,nullptr)==SQLITE_OK);
  aggregate.current=aggregate.db->Prepare("SELECT win(x) OVER (ORDER BY x) FROM (SELECT 1 x UNION ALL SELECT 2)");assert(aggregate.current->Step());aggregate.closing=true;aggregate.current->Close();aggregate.current->Close(true);aggregate.db->Close();
  // A finalizer may extend the connection's weak observer vector. The owning
  // close operation must safely retire the new actual VM before DB teardown.
  Probe close{Database()};close.createWhileClosing=true;assert(sqlite3_create_window_function(close.db->Require(),"win",1,SQLITE_UTF8,&close,Step,Final,Value,Step,nullptr)==SQLITE_OK);
  close.current=close.db->Prepare("SELECT win(x) OVER (ORDER BY x) FROM (SELECT 1 x UNION ALL SELECT 2)");assert(close.current->Step());close.closing=true;close.db->Close();assert(close.created&&close.created->IsFinalized());
  std::cout<<"{\"repeat\":\""<<repeat<<"\",\"scalar\":";Array(scalar.trace);std::cout<<",\"aggregate\":";Array(aggregate.trace);std::cout<<",\"createdDuringCloseRetired\":true}"<<std::endl;
}
