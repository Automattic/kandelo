// Host component fixture: actual portable poll source + actual asynchronous
// POSIX stat. This is not the uncompiled SpiderMonkey native owner/loop.
#include <node_api.h>
#include <uv.h>
#include <cassert>
#include <cerrno>
#include <string>
#include <vector>
#include "stat-poll.h"
namespace F = kandelo::fs_poll;
#define N(call) do { napi_status status_=(call);if(status_!=napi_ok){const napi_extended_error_info* info_;napi_get_last_error_info(env,&info_);napi_throw_error(env,nullptr,info_->error_message);return nullptr;} }while(0)
struct Context;
struct Wrap {
 Context* context;F::uv_fs_poll_t handle; napi_ref object=nullptr;
 napi_async_context async=nullptr; napi_ref onclose=nullptr;
 bool bigint=false,held=false,destroyed=false;
};
struct Context {
 napi_env env;uv_loop_t* host;uv_timer_t timer;F::uv_loop_t loop;
 std::vector<Wrap*> wraps;size_t refs=1,work=0;
 Wrap* starting=nullptr; napi_ref getId=nullptr;
 bool cleanup=false,timerClosed=false; napi_async_cleanup_hook_handle hook=nullptr;
 explicit Context(napi_env env):env(env),host(nullptr){}
 void Retain(){++refs;}void Release(){if(!--refs){assert(timerClosed&&!work);delete this;}}
};
struct Work {Wrap* owner;F::uv_fs_t* request;napi_async_work work;struct stat metadata{};int error=0;};
static void Pump(Context*);
static void TryCleanup(Context* context){
 if(!context->cleanup||context->work||context->loop.closing||context->timerClosed)return;
 for(auto* owner:context->wraps)if(owner->handle.poll_ctx)return;
 context->timerClosed=true;uv_timer_stop(&context->timer);
 uv_close(reinterpret_cast<uv_handle_t*>(&context->timer),[](uv_handle_t* timer){auto* context=static_cast<Context*>(timer->data);if(context->getId){napi_delete_reference(context->env,context->getId);context->getId=nullptr;}napi_remove_async_cleanup_hook(context->hook);context->Release();});
}
static void Wake(uv_timer_t* timer){
 auto* context=static_cast<Context*>(timer->data);
 napi_handle_scope scope;const napi_status opened=napi_open_handle_scope(context->env,&scope);assert(opened==napi_ok);
 uv_update_time(context->host);F::UpdateTime(&context->loop,uv_now(context->host));
 // One native callback per host entry. A callback may mutate/close watchers.
 if(!F::RunOneClose(&context->loop))F::RunOneTimer(&context->loop);
 Pump(context);napi_close_handle_scope(context->env,scope);
}
static void Pump(Context* context){
 TryCleanup(context);if(context->timerClosed)return;
 int64_t delay=F::NextDelay(&context->loop);
 if(delay<0){uv_timer_stop(&context->timer);return;}
 bool referenced=context->loop.closing!=nullptr;
 for(auto* owner:context->wraps)if(F::Active(&owner->handle)&&F::HasRef(&owner->handle))referenced=true;
 if(referenced)uv_ref(reinterpret_cast<uv_handle_t*>(&context->timer));else uv_unref(reinterpret_cast<uv_handle_t*>(&context->timer));
 uv_timer_start(&context->timer,Wake,uint64_t(delay),0);
}
template<typename T> static void Fill(const F::uv_stat_t& s,T* a){
 a[0]=s.st_dev;a[1]=s.st_mode;a[2]=s.st_nlink;a[3]=s.st_uid;a[4]=s.st_gid;a[5]=s.st_rdev;a[6]=s.st_blksize;a[7]=s.st_ino;a[8]=s.st_size;a[9]=s.st_blocks;
 a[10]=s.st_atim.tv_sec;a[11]=s.st_atim.tv_nsec;a[12]=s.st_mtim.tv_sec;a[13]=s.st_mtim.tv_nsec;a[14]=s.st_ctim.tv_sec;a[15]=s.st_ctim.tv_nsec;a[16]=s.st_birthtim.tv_sec;a[17]=s.st_birthtim.tv_nsec;
}
static void Changed(F::uv_fs_poll_t* handle,int status,const F::uv_stat_t* previous,const F::uv_stat_t* current){
 auto* owner=static_cast<Wrap*>(handle->data);auto* context=owner->context;if(context->cleanup)return;
 napi_env env=context->env;napi_handle_scope scope;napi_open_handle_scope(env,&scope);
 napi_value object,callback,stats,buffer,args[2],result;void* data=nullptr;
 if(napi_get_reference_value(env,owner->object,&object)==napi_ok && napi_create_arraybuffer(env,36*8,&data,&buffer)==napi_ok){
  if(owner->bigint){auto* values=static_cast<int64_t*>(data);Fill(*current,values);Fill(*previous,values+18);}
  else{auto* values=static_cast<double*>(data);Fill(*current,values);Fill(*previous,values+18);}
  if(napi_create_typedarray(env,owner->bigint?napi_bigint64_array:napi_float64_array,36,buffer,0,&stats)==napi_ok && napi_get_named_property(env,object,"onchange",&callback)==napi_ok){
   napi_valuetype type;napi_typeof(env,callback,&type);
   if(type==napi_function){napi_create_int32(env,status,&args[0]);args[1]=stats;(void)napi_make_callback(env,owner->async,object,callback,2,args,&result);}
  }
 }
 napi_close_handle_scope(env,scope);
}
static void Closed(F::uv_fs_poll_t* handle){
 auto* owner=static_cast<Wrap*>(handle->data);auto* context=owner->context;napi_env env=context->env;
 napi_handle_scope scope;napi_open_handle_scope(env,&scope);
 if(owner->onclose&&!context->cleanup){napi_value callback,object,result;napi_get_reference_value(env,owner->onclose,&callback);napi_get_reference_value(env,owner->object,&object);(void)napi_make_callback(env,owner->async,object,callback,0,nullptr,&result);}
 if(owner->onclose){napi_delete_reference(env,owner->onclose);owner->onclose=nullptr;}
 if(!owner->destroyed){owner->destroyed=true;napi_async_destroy(env,owner->async);}
 if(owner->held){uint32_t count;napi_reference_unref(env,owner->object,&count);owner->held=false;}
 napi_close_handle_scope(env,scope);
}
static int Submit(F::uv_loop_t* loop,F::uv_fs_t* request){
 auto* context=static_cast<Context*>(loop->data);Wrap* owner=nullptr;
 for(auto* candidate:context->wraps)if(F::OwnsRequest(&candidate->handle,request)){owner=candidate;break;}
 if(!owner)owner=context->starting; // start's explicit owner
 if(!owner||context->cleanup)return -ECANCELED;
 auto* work=new Work{owner,request,nullptr,{},0};napi_value name;napi_env env=context->env;
 napi_create_string_utf8(env,"stat-poll-native-work",NAPI_AUTO_LENGTH,&name);
 napi_status status=napi_create_async_work(env,nullptr,name,[](napi_env,void* value){auto* work=static_cast<Work*>(value);work->error=F::StatPath(work->request->path,&work->metadata);},[](napi_env env,napi_status status,void* value){
  auto* work=static_cast<Work*>(value);auto* context=work->owner->context;
  uv_update_time(context->host);F::UpdateTime(&context->loop,uv_now(context->host));
  if(status!=napi_ok||context->cleanup){F::ClosePoll(&work->owner->handle);work->error=-ECANCELED;}
  F::CompleteStat(work->request,work->error,work->error?nullptr:&work->metadata);
  --context->work;napi_delete_async_work(env,work->work);delete work;Pump(context);
 },work,&work->work);
 if(status!=napi_ok){delete work;return -ENOMEM;}
 status=napi_queue_async_work(env,work->work);
 if(status!=napi_ok){napi_delete_async_work(env,work->work);delete work;return -EAGAIN;}
 ++context->work;return 0;
}
static napi_value Dispatch(napi_env env,napi_callback_info info){
 size_t argc=5;napi_value args[5],self;void* value;N(napi_get_cb_info(env,info,&argc,args,&self,&value));auto* context=static_cast<Context*>(value);
 char op[32];size_t length;N(napi_get_value_string_utf8(env,args[0],op,sizeof(op),&length));napi_value result;N(napi_get_undefined(env,&result));
 if(std::string(op)=="configure"){N(napi_create_reference(env,args[1],1,&context->getId));return result;}
 if(std::string(op)=="create"){
  napi_value object;N(napi_create_object(env,&object));
  napi_value global,objectCtor,setProto;N(napi_get_global(env,&global));N(napi_get_named_property(env,global,"Object",&objectCtor));N(napi_get_named_property(env,objectCtor,"setPrototypeOf",&setProto));napi_value protoArgs[2]{object,args[1]};N(napi_call_function(env,objectCtor,setProto,2,protoArgs,&result));
  auto* owner=new Wrap{context,{}};context->Retain();context->wraps.push_back(owner);F::uv_fs_poll_init(&context->loop,&owner->handle);owner->handle.data=owner;
  napi_valuetype type;N(napi_typeof(env,args[2],&type));if(type==napi_boolean)N(napi_get_value_bool(env,args[2],&owner->bigint));
  N(napi_create_reference(env,object,0,&owner->object));napi_value name;N(napi_create_string_utf8(env,"STATWATCHER-component",NAPI_AUTO_LENGTH,&name));N(napi_async_init(env,object,name,&owner->async));
  N(napi_wrap(env,object,owner,[](napi_env env,void* value,void*){auto* owner=static_cast<Wrap*>(value);assert(!owner->handle.poll_ctx);auto* context=owner->context;for(auto it=context->wraps.begin();it!=context->wraps.end();++it)if(*it==owner){context->wraps.erase(it);break;}if(!owner->destroyed)napi_async_destroy(env,owner->async);napi_delete_reference(env,owner->object);delete owner;context->Release();},nullptr,nullptr));
  return object;
 }
 Wrap* owner;N(napi_unwrap(env,args[1],reinterpret_cast<void**>(&owner)));
 const std::string operation(op);
 if(operation=="getAsyncId"){
  if(!context->getId){napi_throw_error(env,nullptr,"Missing actual component async-ID observer");return nullptr;}
  napi_value getter;N(napi_get_reference_value(env,context->getId,&getter));N(napi_call_function(env,self,getter,1,&args[1],&result));return result;
 }
 if(operation=="hasRef"){N(napi_get_boolean(env,!F::Closing(&owner->handle)&&F::HasRef(&owner->handle),&result));return result;}
 if(operation=="ref"||operation=="unref"){if(!F::Closing(&owner->handle))F::Ref(&owner->handle,operation=="ref");Pump(context);return result;}
 if(operation=="close"){
  if(!F::Closing(&owner->handle)){if(!owner->held){uint32_t count;N(napi_reference_ref(env,owner->object,&count));owner->held=true;}napi_valuetype type;if(argc>2&&napi_typeof(env,args[2],&type)==napi_ok&&type==napi_function)N(napi_create_reference(env,args[2],1,&owner->onclose));F::ClosePoll(&owner->handle);Pump(context);}
  return result;
 }
 assert(operation=="start");N(napi_get_value_string_utf8(env,args[2],nullptr,0,&length));std::string path(length,'\0');N(napi_get_value_string_utf8(env,args[2],path.data(),length+1,&length));uint32_t interval;N(napi_get_value_uint32(env,args[3],&interval));
 if(F::Closing(&owner->handle))return result;
 if(!owner->held){uint32_t count;N(napi_reference_ref(env,owner->object,&count));owner->held=true;}
 uv_update_time(context->host);F::UpdateTime(&context->loop,uv_now(context->host));
 Wrap* prior=context->starting;context->starting=owner;
 const int status=F::uv_fs_poll_start(&owner->handle,Changed,path.c_str(),interval);context->starting=prior;Pump(context);
 if(status)N(napi_create_int32(env,status,&result));return result;
}
static napi_value Init(napi_env env,napi_value exports){
 auto* context=new Context(env);N(napi_get_uv_event_loop(env,&context->host));uv_timer_init(context->host,&context->timer);context->timer.data=context;uv_unref(reinterpret_cast<uv_handle_t*>(&context->timer));context->loop.data=context;context->loop.submit=Submit;context->loop.closed=Closed;
 N(napi_add_async_cleanup_hook(env,[](napi_async_cleanup_hook_handle,void* value){auto* context=static_cast<Context*>(value);context->cleanup=true;for(auto* owner:context->wraps)if(owner->held)F::ClosePoll(&owner->handle);while(F::RunOneClose(&context->loop)){}Pump(context);},context,&context->hook));
 napi_value function;N(napi_create_function(env,"statWatcher",NAPI_AUTO_LENGTH,Dispatch,context,&function));N(napi_set_named_property(env,exports,"statWatcher",function));return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
