// Native reference component only. Actual production OutputHandle/WindowSize
// implementations below; Node supplies the JSAPI bridge and stream runtime.
#include <node_api.h>
#include "terminal-operations.h"
#include <memory>
#include <stdexcept>
static void Check(napi_status status){if(status!=napi_ok)throw std::runtime_error("NAPI TTY owner fixture conversion");}
static napi_value Number(napi_env e,int64_t n){napi_value v;Check(napi_create_int64(e,n,&v));return v;}
static napi_value Packet(napi_env e,int error,napi_value value=nullptr){napi_value p;Check(napi_create_object(e,&p));Check(napi_set_named_property(e,p,"error",Number(e,error)));if(value)Check(napi_set_named_property(e,p,"value",value));return p;}
static void Finalize(napi_env,void* p,void*){delete static_cast<kandelo::terminal::OutputHandle*>(p);}
static napi_value WindowSize(napi_env e,napi_callback_info info){size_t argc=1;napi_value a[1];Check(napi_get_cb_info(e,info,&argc,a,nullptr,nullptr));int32_t fd;Check(napi_get_value_int32(e,a[0],&fd));std::array<unsigned,2> size{};const int error=kandelo::terminal::WindowSize(fd,&size);napi_value array;Check(napi_create_array_with_length(e,2,&array));for(unsigned i=0;i<2;++i)Check(napi_set_element(e,array,i,Number(e,size[i])));return Packet(e,error,error?nullptr:array);}
static napi_value Open(napi_env e,napi_callback_info info){size_t argc=1;napi_value a[1];Check(napi_get_cb_info(e,info,&argc,a,nullptr,nullptr));int32_t fd;Check(napi_get_value_int32(e,a[0],&fd));auto p=std::make_unique<kandelo::terminal::OutputHandle>();const int error=p->Open(fd);if(error)return Packet(e,error);napi_value value;Check(napi_create_external(e,p.get(),Finalize,nullptr,&value));p.release();return Packet(e,0,value);}
static kandelo::terminal::OutputHandle* Owner(napi_env e,napi_value value){void* p;Check(napi_get_value_external(e,value,&p));return static_cast<kandelo::terminal::OutputHandle*>(p);}
static napi_value Write(napi_env e,napi_callback_info info){size_t argc=2;napi_value a[2];Check(napi_get_cb_info(e,info,&argc,a,nullptr,nullptr));auto* p=Owner(e,a[0]);void* data;size_t size;Check(napi_get_buffer_info(e,a[1],&data,&size));const auto result=p->Write(static_cast<uint8_t*>(data),size);return Packet(e,result.error,Number(e,result.transferred));}
static napi_value Close(napi_env e,napi_callback_info info){size_t argc=1;napi_value a[1];Check(napi_get_cb_info(e,info,&argc,a,nullptr,nullptr));Owner(e,a[0])->Close();return Packet(e,0);}
static napi_value Descriptor(napi_env e,napi_callback_info info){size_t argc=1;napi_value a[1];Check(napi_get_cb_info(e,info,&argc,a,nullptr,nullptr));return Number(e,Owner(e,a[0])->Descriptor());}
static napi_value Flags(napi_env e,napi_callback_info info){size_t argc=2;napi_value a[2];Check(napi_get_cb_info(e,info,&argc,a,nullptr,nullptr));int32_t fd;Check(napi_get_value_int32(e,a[0],&fd));if(argc>1){bool value;Check(napi_get_value_bool(e,a[1],&value));const int old=fcntl(fd,F_GETFL);if(old<0)return Packet(e,-errno);if(fcntl(fd,F_SETFL,value?old|O_NONBLOCK:old&~O_NONBLOCK)<0)return Packet(e,-errno);}const int flags=fcntl(fd,F_GETFL);return Packet(e,flags<0?-errno:0,flags<0?nullptr:Number(e,flags&O_NONBLOCK?1:0));}
static napi_value Init(napi_env e,napi_value exports){struct Entry{const char* name;napi_callback fn;};for(const auto& entry:{Entry{"windowSize",WindowSize},{"openOutput",Open},{"writeOutput",Write},{"closeOutput",Close},{"descriptor",Descriptor},{"nonblocking",Flags}}){napi_value fn;Check(napi_create_function(e,entry.name,NAPI_AUTO_LENGTH,entry.fn,nullptr,&fn));Check(napi_set_named_property(e,exports,entry.name,fn));}return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
