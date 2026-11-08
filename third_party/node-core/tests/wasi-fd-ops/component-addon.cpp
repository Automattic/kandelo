// Test-only N-API bridge for the actual portable WASI Context. Production uses
// native-wasi.cpp and real SpiderMonkey brands/realms instead of this bridge.
#include <node_api.h>
#include "wasi-context.h"
#include <cmath>
static napi_ref viewFactory;
struct Box { std::unique_ptr<kandelo::wasi::Context> context; napi_ref memory = nullptr; };
static napi_value Throw(napi_env env, const char* code, const char* text) {
  napi_throw_error(env,code,text); return nullptr;
}
static void Finalize(napi_env env,void* data,void*) { auto* box=static_cast<Box*>(data); if(box->memory)napi_delete_reference(env,box->memory); delete box; }
static bool Strings(napi_env env,napi_value input,std::vector<std::string>& result) {
  uint32_t length; if(napi_get_array_length(env,input,&length)!=napi_ok)return false;
  for(uint32_t i=0;i<length;++i){napi_value value;size_t size;napi_get_element(env,input,i,&value);napi_get_value_string_utf8(env,value,nullptr,0,&size);std::string text(size,'\0');napi_get_value_string_utf8(env,value,text.data(),size+1,&size);result.push_back(std::move(text));}return true;
}
static napi_value Construct(napi_env env,napi_callback_info info) {
  size_t argc=4;napi_value args[4],self;napi_get_cb_info(env,info,&argc,args,&self,nullptr);
  try {
    std::vector<std::string> argv,envp,preopens; if(argc!=4 || !Strings(env,args[0],argv)||!Strings(env,args[1],envp)||!Strings(env,args[2],preopens))return Throw(env,"ERR_FIXTURE","bad fixture constructor");
    int stdio[3];for(uint32_t i=0;i<3;++i){napi_value fd;napi_get_element(env,args[3],i,&fd);napi_get_value_int32(env,fd,&stdio[i]);}
    auto box=std::make_unique<Box>();box->context=std::make_unique<kandelo::wasi::Context>(std::move(argv),std::move(envp),preopens,stdio);
    if(napi_wrap(env,self,box.get(),Finalize,nullptr,nullptr)!=napi_ok)return nullptr;box.release();return self;
  }catch(const kandelo::wasi::Error& error){
    napi_value message,exception,code,number,syscall;napi_create_string_utf8(env,(std::string(error.what())+", uvwasi_init").c_str(),NAPI_AUTO_LENGTH,&message);napi_create_error(env,nullptr,message,&exception);napi_create_string_utf8(env,error.what(),NAPI_AUTO_LENGTH,&code);napi_set_named_property(env,exception,"code",code);napi_create_uint32(env,error.code,&number);napi_set_named_property(env,exception,"errno",number);napi_create_string_utf8(env,"uvwasi_init",NAPI_AUTO_LENGTH,&syscall);napi_set_named_property(env,exception,"syscall",syscall);napi_throw(env,exception);return nullptr;
  }catch(const std::bad_alloc&){return Throw(env,"ENOMEM","allocation failed");}
}
static napi_value SetMemory(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value input,self;napi_get_cb_info(env,info,&argc,&input,&self,nullptr);
  Box* box;napi_unwrap(env,self,reinterpret_cast<void**>(&box));napi_value factory,global,view;napi_get_reference_value(env,viewFactory,&factory);napi_get_global(env,&global);
  if(napi_call_function(env,global,factory,1,&input,&view)!=napi_ok){
    napi_value pending;napi_get_and_clear_last_exception(env,&pending);
    napi_throw_type_error(env,"ERR_INVALID_ARG_TYPE","\"instance.exports.memory\" property must be a WebAssembly.Memory object");return nullptr;
  }
  if(box->memory)napi_delete_reference(env,box->memory);napi_create_reference(env,input,1,&box->memory);napi_value result;napi_get_undefined(env,&result);return result;
}
static napi_value Import(napi_env env,napi_callback_info info) {
  size_t argc=6;napi_value args[6],self;void* data;napi_get_cb_info(env,info,&argc,args,&self,&data);
  uint64_t v[5]{};uint32_t result=0;
  switch(reinterpret_cast<uintptr_t>(data)) {
    case 0:
      if(argc!=2) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      break;
    case 1:
      if(argc!=2) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      break;
    case 2:
      if(argc!=2) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      break;
    case 3:
      if(argc!=3) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {bool lossless;if(napi_get_value_bigint_uint64(env,args[1],&v[1],&lossless)!=napi_ok)goto invalid;}
      {double number;if(napi_get_value_double(env,args[2],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[2]=static_cast<uint32_t>(number);}
      break;
    case 4:
      if(argc!=2) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      break;
    case 5:
      if(argc!=2) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      break;
    case 6:
      if(argc!=1) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      break;
    case 7:
      if(argc!=1) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      break;
    case 8:
      if(argc!=2) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      break;
    case 9:
      if(argc!=2) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      break;
    case 10:
      if(argc!=3) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {bool lossless;if(napi_get_value_bigint_uint64(env,args[1],&v[1],&lossless)!=napi_ok)goto invalid;}
      {bool lossless;if(napi_get_value_bigint_uint64(env,args[2],&v[2],&lossless)!=napi_ok)goto invalid;}
      break;
    case 11:
      if(argc!=2) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      break;
    case 12:
      if(argc!=2) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {bool lossless;if(napi_get_value_bigint_uint64(env,args[1],&v[1],&lossless)!=napi_ok)goto invalid;}
      break;
    case 13:
      if(argc!=5) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[2],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[2]=static_cast<uint32_t>(number);}
      {bool lossless;if(napi_get_value_bigint_uint64(env,args[3],&v[3],&lossless)!=napi_ok)goto invalid;}
      {double number;if(napi_get_value_double(env,args[4],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[4]=static_cast<uint32_t>(number);}
      break;
    case 14:
      if(argc!=2) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      break;
    case 15:
      if(argc!=3) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[2],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[2]=static_cast<uint32_t>(number);}
      break;
    case 16:
      if(argc!=5) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[2],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[2]=static_cast<uint32_t>(number);}
      {bool lossless;if(napi_get_value_bigint_uint64(env,args[3],&v[3],&lossless)!=napi_ok)goto invalid;}
      {double number;if(napi_get_value_double(env,args[4],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[4]=static_cast<uint32_t>(number);}
      break;
    case 17:
      if(argc!=4) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[2],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[2]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[3],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[3]=static_cast<uint32_t>(number);}
      break;
    case 18:
      if(argc!=4) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {bool lossless;if(napi_get_value_bigint_uint64(env,args[1],&v[1],&lossless)!=napi_ok)goto invalid;}
      {double number;if(napi_get_value_double(env,args[2],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[2]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[3],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[3]=static_cast<uint32_t>(number);}
      break;
    case 19:
      if(argc!=1) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      break;
    case 20:
      if(argc!=2) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      break;
    case 21:
      if(argc!=4) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[2],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[2]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[3],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[3]=static_cast<uint32_t>(number);}
      break;
    case 22:
      if(argc!=1) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      break;
    case 23:
      if(argc!=2) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      break;
    case 24:
      if(argc!=0) goto invalid;
      break;
    case 25:
      if(argc!=3) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {bool lossless;if(napi_get_value_bigint_uint64(env,args[1],&v[1],&lossless)!=napi_ok)goto invalid;}
      {bool lossless;if(napi_get_value_bigint_uint64(env,args[2],&v[2],&lossless)!=napi_ok)goto invalid;}
      break;
    case 26:
      if(argc!=4) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {bool lossless;if(napi_get_value_bigint_uint64(env,args[1],&v[1],&lossless)!=napi_ok)goto invalid;}
      {bool lossless;if(napi_get_value_bigint_uint64(env,args[2],&v[2],&lossless)!=napi_ok)goto invalid;}
      {double number;if(napi_get_value_double(env,args[3],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[3]=static_cast<uint32_t>(number);}
      break;
    case 27:
      if(argc!=2) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      break;
    case 28:
      if(argc!=5) goto invalid;
      {double number;if(napi_get_value_double(env,args[0],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[0]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[1],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[1]=static_cast<uint32_t>(number);}
      {double number;if(napi_get_value_double(env,args[2],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[2]=static_cast<uint32_t>(number);}
      {bool lossless;if(napi_get_value_bigint_uint64(env,args[3],&v[3],&lossless)!=napi_ok)goto invalid;}
      {double number;if(napi_get_value_double(env,args[4],&number)!=napi_ok || !std::isfinite(number)||number<0||number>UINT32_MAX||std::trunc(number)!=number)goto invalid;v[4]=static_cast<uint32_t>(number);}
      break;
  }
  {
    Box* box;napi_unwrap(env,self,reinterpret_cast<void**>(&box));
    if(!box->memory)return Throw(env,"ERR_WASI_NOT_STARTED","wasi.start() has not been called");
    napi_value memoryObject,factory,global,view,buffer;napi_get_reference_value(env,box->memory,&memoryObject);napi_get_reference_value(env,viewFactory,&factory);napi_get_global(env,&global);
    if(napi_call_function(env,global,factory,1,&memoryObject,&view)!=napi_ok)return nullptr;
    void* pointer;size_t length,offset;napi_typedarray_type type;
    if(napi_get_typedarray_info(env,view,&type,&length,&pointer,&buffer,&offset)!=napi_ok)return Throw(env,"ERR_FIXTURE","actual memory view required");
    kandelo::wasi::Memory memory{static_cast<uint8_t*>(pointer),length,true};
    auto& context=*box->context;
    try { switch(reinterpret_cast<uintptr_t>(data)) {
      case 0: result=context.Strings(memory,false,false,v[0],v[1]); break;
      case 1: result=context.Strings(memory,false,true,v[0],v[1]); break;
      case 2: result=context.Clock(memory,v[0],v[1],true); break;
      case 3: result=context.Clock(memory,v[0],v[2],false); break;
      case 4: result=context.Strings(memory,true,false,v[0],v[1]); break;
      case 5: result=context.Strings(memory,true,true,v[0],v[1]); break;
      case 6: result=context.Close(v[0]); break;
      case 7: result=context.Sync(v[0],true); break;
      case 8: result=context.Fdstat(memory,v[0],v[1]); break;
      case 9: result=context.SetFlags(v[0],v[1]); break;
      case 10: result=context.SetRights(v[0],v[1],v[2]); break;
      case 11: result=context.Filestat(memory,v[0],v[1]); break;
      case 12: result=context.SetSize(v[0],v[1]); break;
      case 13: result=context.Io(memory,v[0],v[1],v[2],v[3],v[4],false,true); break;
      case 14: result=context.Prestat(memory,v[0],v[1]); break;
      case 15: result=context.PrestatName(memory,v[0],v[1],v[2]); break;
      case 16: result=context.Io(memory,v[0],v[1],v[2],v[3],v[4],true,true); break;
      case 17: result=context.Io(memory,v[0],v[1],v[2],0,v[3],false,false); break;
      case 18: result=context.Seek(memory,v[0],static_cast<int64_t>(v[1]),v[2],v[3]); break;
      case 19: result=context.Sync(v[0],false); break;
      case 20: result=context.Seek(memory,v[0],0,UVWASI_WHENCE_CUR,v[1],true); break;
      case 21: result=context.Io(memory,v[0],v[1],v[2],0,v[3],true,false); break;
      case 22: context.Exit(v[0]); break;
      case 23: result=context.Random(memory,v[0],v[1]); break;
      case 24: result=context.Yield(); break;
      case 25: result=context.Allocate(v[0],v[1],v[2]); break;
      case 26: result=context.SetTimes(v[0],v[1],v[2],v[3]); break;
      case 27: result=context.Renumber(v[0],v[1]); break;
      case 28: result=context.Readdir(memory,v[0],v[1],v[2],v[3],v[4]); break;
    }}catch(const kandelo::wasi::Error& error){result=error.code;}catch(const std::bad_alloc&){result=UVWASI_ENOMEM;}
  }
  {napi_value value;napi_create_uint32(env,result,&value);return value;}
invalid:
  napi_value value;napi_create_uint32(env,UVWASI_EINVAL,&value);return value;
}
static napi_value Initialize(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value factory,self;napi_get_cb_info(env,info,&argc,&factory,&self,nullptr);napi_create_reference(env,factory,1,&viewFactory);
  napi_property_descriptor methods[]={
    {"args_get",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(0)},
    {"args_sizes_get",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(1)},
    {"clock_res_get",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(2)},
    {"clock_time_get",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(3)},
    {"environ_get",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(4)},
    {"environ_sizes_get",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(5)},
    {"fd_allocate",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(25)},
    {"fd_close",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(6)},
    {"fd_datasync",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(7)},
    {"fd_fdstat_get",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(8)},
    {"fd_fdstat_set_flags",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(9)},
    {"fd_fdstat_set_rights",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(10)},
    {"fd_filestat_get",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(11)},
    {"fd_filestat_set_size",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(12)},
    {"fd_filestat_set_times",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(26)},
    {"fd_pread",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(13)},
    {"fd_prestat_get",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(14)},
    {"fd_prestat_dir_name",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(15)},
    {"fd_pwrite",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(16)},
    {"fd_read",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(17)},
    {"fd_readdir",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(28)},
    {"fd_renumber",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(27)},
    {"fd_seek",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(18)},
    {"fd_sync",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(19)},
    {"fd_tell",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(20)},
    {"fd_write",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(21)},
    {"proc_exit",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(22)},
    {"random_get",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(23)},
    {"sched_yield",nullptr,Import,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),reinterpret_cast<void*>(24)},
    {"_setMemory",nullptr,SetMemory,nullptr,nullptr,nullptr,static_cast<napi_property_attributes>(napi_writable|napi_configurable|napi_enumerable),nullptr},
  };
  napi_value constructor;napi_define_class(env,"WASI",NAPI_AUTO_LENGTH,Construct,nullptr,sizeof(methods)/sizeof(methods[0]),methods,&constructor);return constructor;
}
static napi_value Module(napi_env env,napi_value exports){napi_property_descriptor property={"initialize",nullptr,Initialize,nullptr,nullptr,nullptr,napi_default,nullptr};napi_define_properties(env,exports,1,&property);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Module)
