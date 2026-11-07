#include "http-parser.h"
#include <iostream>
#include <sstream>
#include <thread>
#include <chrono>
#include <array>
using namespace kandelo::http;
struct Owner {
  unsigned id; Parser parser{"GET",0,false,false,true}; bool removeAtHeaders=false;
  explicit Owner(unsigned id):id(id){}
  static int Headers(void* opaque,const Event&) { auto* o=static_cast<Owner*>(opaque);if(o->removeAtHeaders)o->parser.RemoveConnections();return 0; }
};
void Print(const std::vector<ConnectionRecord*>& records) {
 std::cout<<'[';bool first=true;for(auto* r:records){if(!first)std::cout<<',';first=false;std::cout<<static_cast<Owner*>(r->Owner())->id;}std::cout<<"]\n";
}
int main(){
 auto list=std::make_shared<ConnectionsList>();std::array<std::unique_ptr<Owner>,16> owners;
 std::string line;while(std::getline(std::cin,line)){
  std::istringstream in(line);std::string op;unsigned id;in>>op;
  if(op=="new"){in>>id;owners[id]=std::make_unique<Owner>(id);owners[id]->parser.AttachConnections(list,owners[id].get());}
  else if(op=="feed"){std::string hex;in>>id>>hex;std::vector<uint8_t> bytes;for(size_t i=0;i<hex.size();i+=2)bytes.push_back(std::stoul(hex.substr(i,2),nullptr,16));auto* o=owners[id].get();o->parser.Feed(bytes.data(),bytes.size(),{o,Owner::Headers});}
  else if(op=="remove"){in>>id;owners[id]->parser.RemoveConnections();}
  else if(op=="removeAtHeaders"){in>>id;owners[id]->removeAtHeaders=true;}
  else if(op=="close"){in>>id;owners[id].reset();}
  else if(op=="sleep"){in>>id;std::this_thread::sleep_for(std::chrono::milliseconds(id));}
  else if(op=="all")Print(list->All());else if(op=="idle")Print(list->Idle());else if(op=="active")Print(list->Active());
  else if(op=="expired"){uint32_t h,r;in>>h>>r;Print(list->Expired(h,r));}
  else if(op=="retained"){
   std::weak_ptr<ConnectionsList> weak=list;list.reset();assert(!weak.expired());for(auto& o:owners)o.reset();assert(weak.expired());std::cout<<"true\n";
  }else return 2;
 }
}
