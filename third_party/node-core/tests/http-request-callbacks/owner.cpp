// Actual portable owner control; not production JSAPI or guest execution.
#include "http-parser.h"
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
using namespace kandelo::http;
struct Call {
  Parser& parser;
  std::shared_ptr<ConnectionsList> list;
  std::string mode;
  bool inFeed = false, failed = false;
  std::vector<std::string> rows;
  static int Invoke(void* opaque, const Event& event) {
    auto& s = *static_cast<Call*>(opaque);
    const std::string kind = event.type == Event::Type::Headers ? "headers" : event.type == Event::Type::Body ? "body" : "complete";
    std::string body;
    for (auto c : event.body) { static const char h[]="0123456789abcdef"; body += h[c>>4];body += h[c&15]; }
    s.rows.push_back("[\""+kind+"\","+std::to_string(s.list->Active().size())+","+std::to_string(s.list->Idle().size())+","+(s.inFeed?"true":"false")+",\""+body+"\"]");
    if (kind == "body" && s.mode == "remove-body") s.parser.RemoveConnections();
    if ((kind == "body" && s.mode == "throw-body") || (kind == "complete" && s.mode == "throw-complete")) {
      s.failed = true; return event.type == Event::Type::Body ? int(HPE_USER) : -1;
    }
    return 0;
  }
};
int main(int argc,char**argv) {
  if(argc<3)return 2;
  Parser parser("GET",0,false,false,true);auto list=std::make_shared<ConnectionsList>();parser.AttachConnections(list,&parser);Call call{parser,list,argv[1]};
  HeadersHandler handler{&call,Call::Invoke};
#if HTTP_CALLBACKS
  handler.body=Call::Invoke;handler.complete=Call::Invoke;
#endif
  std::string code;
  auto consume=[&](Step step){
#if !HTTP_CALLBACKS
    for(auto& event:step.events)if(Call::Invoke(&call,event)!=0)break;
#endif
    code=step.code;
  };
  for(int i=2;i<argc&&!call.failed;++i){
    const std::string hex=argv[i];std::vector<uint8_t> bytes;
    for(size_t at=0;at+1<hex.size();at+=2)bytes.push_back(std::stoul(hex.substr(at,2),nullptr,16));
    call.inFeed=true;auto step=parser.Feed(bytes.data(),bytes.size(),handler);call.inFeed=false;consume(std::move(step));
  }
  if(call.mode=="finish"&&!call.failed){call.inFeed=true;auto step=parser.Finish(handler);call.inFeed=false;consume(std::move(step));}
  printf("{\"rows\":[");for(size_t i=0;i<call.rows.size();++i){if(i)putchar(',');fputs(call.rows[i].c_str(),stdout);}printf("],\"failed\":%s,\"active\":%zu,\"idle\":%zu}\n",call.failed?"true":"false",list->Active().size(),list->Idle().size());
}
