// Component boundary only: real candidate Lease/Owner with native Node roots,
// conversions and GC; not SpiderMonkey classes, promises or context teardown.
#include "socket-owner.h"
#include <node_api.h>
#include <fcntl.h>
#include <stdexcept>
#include <string>
#include <arpa/inet.h>
#include <cstdlib>
#include <new>
static bool failNextAllocation = false;
void* operator new(size_t size) { if (std::exchange(failNextAllocation, false)) throw std::bad_alloc(); if(void* p=std::malloc(size?size:1))return p;throw std::bad_alloc(); }
void operator delete(void* p) noexcept {std::free(p);}
void operator delete(void* p,size_t) noexcept {std::free(p);}
using kandelo::socket::Lease;
using kandelo::socket::Owner;
namespace {
struct Box { bool socket; Lease lease; std::unique_ptr<Owner> owner; explicit Box(bool socket):socket(socket){} };
static uint64_t generation=0;
static void Check(napi_status status){if(status!=napi_ok)throw std::runtime_error("N-API operation failed");}
static void Finalize(napi_env,void* value,void*){delete static_cast<Box*>(value);}
static napi_value Wrap(napi_env env,std::unique_ptr<Box> box){napi_value value;Check(napi_create_object(env,&value));Check(napi_wrap(env,value,box.get(),Finalize,nullptr,nullptr));box.release();return value;}
static Box* Unwrap(napi_env env,napi_value value,bool socket){Box* box=nullptr;Check(napi_unwrap(env,value,reinterpret_cast<void**>(&box)));if(!box||box->socket!=socket)throw std::runtime_error("Wrong actual ownership kind");return box;}
static napi_value Number(napi_env env,int32_t n){napi_value value;Check(napi_create_int32(env,n,&value));return value;}
static napi_value Undefined(napi_env env){napi_value value;Check(napi_get_undefined(env,&value));return value;}
static void System(int result){if(result<0)throw std::runtime_error(std::string("Actual syscall: ")+std::to_string(errno));}
static int Accepted(int supplied=-1){Lease local;int listener=supplied;if(listener<0){Lease fresh(::socket(AF_INET,SOCK_STREAM,0));System(fresh.Fd());if(!local.Adopt(fresh))throw std::runtime_error("listener lease failed");listener=local.Fd();sockaddr_in endpoint{};endpoint.sin_family=AF_INET;endpoint.sin_addr.s_addr=htonl(INADDR_LOOPBACK);System(::bind(listener,reinterpret_cast<sockaddr*>(&endpoint),sizeof(endpoint)));System(::listen(listener,1));}sockaddr_in endpoint{};socklen_t size=sizeof(endpoint);System(::getsockname(listener,reinterpret_cast<sockaddr*>(&endpoint),&size));Lease client(::socket(AF_INET,SOCK_STREAM,0));System(client.Fd());System(::connect(client.Fd(),reinterpret_cast<sockaddr*>(&endpoint),size));const int fd=::accept(listener,nullptr,nullptr);System(fd);return fd;}
static napi_value NewLease(napi_env env,int fd){Lease prior(fd);auto box=std::make_unique<Box>(false);if(!box->lease.Adopt(prior))throw std::runtime_error("Lease transfer failed");return Wrap(env,std::move(box));}
template<class F>static napi_value Guard(napi_env env,F&& f){try{return f();}catch(const std::exception& e){bool pending=false;napi_is_exception_pending(env,&pending);if(!pending)napi_throw_error(env,nullptr,e.what());return nullptr;}}
static napi_value Make(napi_env env,napi_callback_info info){return Guard(env,[&]{napi_value arg;size_t n=1;int32_t fd=-1;Check(napi_get_cb_info(env,info,&n,&arg,nullptr,nullptr));if(n)Check(napi_get_value_int32(env,arg,&fd));return NewLease(env,Accepted(fd));});}
static int lastFailureFd=-1;
static napi_value Oom(napi_env env,napi_callback_info){return Guard(env,[&]()->napi_value{Lease prior(Accepted());lastFailureFd=prior.Fd();failNextAllocation=true;auto box=std::make_unique<Box>(false);if(!box->lease.Adopt(prior))throw std::runtime_error("lease transfer failed");return Wrap(env,std::move(box));});}
static napi_value FailedFd(napi_env env,napi_callback_info){return Number(env,lastFailureFd);}
static napi_value Address(napi_env env,napi_callback_info info){return Guard(env,[&]{napi_value args[2],value,field;size_t n=2;int32_t fd;bool peer=false;Check(napi_get_cb_info(env,info,&n,args,nullptr,nullptr));Check(napi_get_value_int32(env,args[0],&fd));if(n>1)Check(napi_get_value_bool(env,args[1],&peer));sockaddr_in endpoint{};socklen_t size=sizeof(endpoint);System(peer ? ::getpeername(fd,reinterpret_cast<sockaddr*>(&endpoint),&size) : ::getsockname(fd,reinterpret_cast<sockaddr*>(&endpoint),&size));char address[INET_ADDRSTRLEN];if(!inet_ntop(AF_INET,&endpoint.sin_addr,address,sizeof(address)))throw std::runtime_error("actual address conversion failed");Check(napi_create_object(env,&value));Check(napi_create_string_utf8(env,address,NAPI_AUTO_LENGTH,&field));Check(napi_set_named_property(env,value,"address",field));Check(napi_create_string_utf8(env,"IPv4",NAPI_AUTO_LENGTH,&field));Check(napi_set_named_property(env,value,"family",field));Check(napi_set_named_property(env,value,"port",Number(env,ntohs(endpoint.sin_port))));return value;});}
static napi_value Close(napi_env env,napi_callback_info info){return Guard(env,[&]{napi_value arg;size_t n=1;Check(napi_get_cb_info(env,info,&n,&arg,nullptr,nullptr));Unwrap(env,arg,false)->lease.Close();return Undefined(env);});}
static napi_value Fd(napi_env env,napi_callback_info info){return Guard(env,[&]{napi_value arg;size_t n=1;Check(napi_get_cb_info(env,info,&n,&arg,nullptr,nullptr));return Number(env,Unwrap(env,arg,false)->lease.Fd());});}
static napi_value Adopt(napi_env env,napi_callback_info info){return Guard(env,[&]()->napi_value{napi_value args[2];size_t n=2;Check(napi_get_cb_info(env,info,&n,args,nullptr,nullptr));Box* lease=Unwrap(env,args[0],false);auto prepared=std::make_unique<Box>(true);prepared->owner=std::make_unique<Owner>(++generation);Box* raw=prepared.get();napi_value owner=Wrap(env,std::move(prepared));if(n>1){napi_valuetype type;Check(napi_typeof(env,args[1],&type));if(type==napi_function){napi_value ignored;if(napi_call_function(env,Undefined(env),args[1],1,&owner,&ignored)!=napi_ok){raw->owner->Close();return nullptr;}}}if(!raw->owner->Adopt(lease->lease)){raw->owner->Close();throw std::runtime_error("Adoption failed after real init");}return owner;});}
static napi_value CloseOwner(napi_env env,napi_callback_info info){return Guard(env,[&]{napi_value arg;size_t n=1;Check(napi_get_cb_info(env,info,&n,&arg,nullptr,nullptr));Unwrap(env,arg,true)->owner->Close();return Undefined(env);});}
static napi_value OwnerFd(napi_env env,napi_callback_info info){return Guard(env,[&]{napi_value arg;size_t n=1;Check(napi_get_cb_info(env,info,&n,&arg,nullptr,nullptr));return Number(env,Unwrap(env,arg,true)->owner->Fd());});}
static napi_value Open(napi_env env,napi_callback_info info){return Guard(env,[&]{napi_value arg,result;size_t n=1;int32_t fd;Check(napi_get_cb_info(env,info,&n,&arg,nullptr,nullptr));Check(napi_get_value_int32(env,arg,&fd));Check(napi_get_boolean(env,::fcntl(fd,F_GETFD)>=0,&result));return result;});}
static napi_value Reuse(napi_env env,napi_callback_info info){return Guard(env,[&]{napi_value args[2];size_t n=2;bool socket=false;Check(napi_get_cb_info(env,info,&n,args,nullptr,nullptr));if(n>1)Check(napi_get_value_bool(env,args[1],&socket));Box* box=Unwrap(env,args[0],socket);const int old=socket?box->owner->Fd():box->lease.Fd();if(old<0)throw std::runtime_error("No live descriptor to recycle");if(socket)box->owner->Close();else box->lease.Close();Lease replacement(::socket(AF_INET,SOCK_STREAM,0));System(replacement.Fd());if(replacement.Fd()==old)return NewLease(env,replacement.Release());System(::dup2(replacement.Fd(),old));return NewLease(env,old);});}
static napi_value Flag(napi_env env,napi_callback_info info){return Guard(env,[&]{napi_value arg;size_t n=1;Check(napi_get_cb_info(env,info,&n,&arg,nullptr,nullptr));int flag=0;socklen_t size=sizeof(flag);System(::getsockopt(Unwrap(env,arg,false)->lease.Fd(),SOL_SOCKET,SO_KEEPALIVE,&flag,&size));return Number(env,flag);});}
static napi_value KeepAlive(napi_env env,napi_callback_info info){return Guard(env,[&]()->napi_value{napi_value args[3],number;size_t n=3;bool enabled;uint32_t idle;Check(napi_get_cb_info(env,info,&n,args,nullptr,nullptr));Box* box=Unwrap(env,args[0],true);Check(napi_get_value_bool(env,args[1],&enabled));if(napi_coerce_to_number(env,args[2],&number)!=napi_ok)return nullptr;Check(napi_get_value_uint32(env,number,&idle));return Number(env,box->owner->SetKeepAlive(enabled,idle));});}
}
NAPI_MODULE_INIT(){napi_property_descriptor methods[]={
 {"oom",nullptr,Oom,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"failedFd",nullptr,FailedFd,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"address",nullptr,Address,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"make",nullptr,Make,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"close",nullptr,Close,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"fd",nullptr,Fd,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"adopt",nullptr,Adopt,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"closeOwner",nullptr,CloseOwner,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"ownerFd",nullptr,OwnerFd,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"open",nullptr,Open,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"reuse",nullptr,Reuse,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"keepAliveFlag",nullptr,Flag,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"keepAlive",nullptr,KeepAlive,nullptr,nullptr,nullptr,napi_default,nullptr}};
 if(napi_define_properties(env,exports,sizeof(methods)/sizeof(methods[0]),methods)!=napi_ok)return nullptr;return exports;}
