// Host-only N-API component boundary. Actual portable cp algorithms + POSIX
// worker execution; not the production SpiderMonkey class/provider/GC bridge.
#include <node_api.h>
#include <uv.h>
#include "copy-directory-operations.h"
#include <memory>
#include <stdexcept>
#include <cstring>
using namespace kandelo::nodefs::cp;
namespace {
const napi_type_tag jobTag{0x3d09fab695ab4e81ULL,0xa4e1559e85cd23f7ULL};
struct Pending {};
void Check(napi_env env, napi_status status) {
  if (status == napi_ok) return;
  if (status != napi_pending_exception) napi_throw_error(env, nullptr, "N-API component boundary failure");
  throw Pending{};
}
napi_value Undefined(napi_env env) { napi_value value; Check(env, napi_get_undefined(env, &value)); return value; }
napi_value Text(napi_env env, const std::string& text) {
  napi_value value; Check(env, napi_create_string_utf8(env, text.data(), text.size(), &value)); return value;
}
napi_value Number(napi_env env, int value) { napi_value result; Check(env, napi_create_int32(env, value, &result)); return result; }
std::string String(napi_env env, napi_value value) {
  napi_valuetype type; Check(env, napi_typeof(env, value, &type));
  if (type == napi_string) {
    size_t length; Check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length));
    std::string text(length, '\0');
    Check(env, napi_get_value_string_utf8(env, value, text.data(), length + 1, &length)); return text;
  }
  bool typed; Check(env, napi_is_typedarray(env, value, &typed));
  if (!typed) { napi_throw_type_error(env, nullptr, "Native path must be string or Uint8Array"); throw Pending{}; }
  napi_typedarray_type kind; size_t length; void* data; napi_value buffer; size_t offset;
  Check(env, napi_get_typedarray_info(env, value, &kind, &length, &data, &buffer, &offset));
  if (kind != napi_uint8_array) { napi_throw_type_error(env, nullptr, "Native path requires Uint8Array"); throw Pending{}; }
  return length ? std::string(static_cast<const char*>(data), length) : std::string();
}
bool Boolean(napi_env env, napi_value value) { bool result; Check(env, napi_get_value_bool(env, value, &result)); return result; }
int Integer(napi_env env, napi_value value) { int32_t result; Check(env, napi_get_value_int32(env, value, &result)); return result; }
void Own(napi_env env, napi_value object, const char* name, napi_value value) {
  napi_property_descriptor property{name, nullptr, nullptr, nullptr, nullptr, value, napi_default_jsproperty, nullptr};
  Check(env, napi_define_properties(env, object, 1, &property));
}
napi_value Packet(napi_env env, const CpError& error) {
  if (error.kind == CpError::kNone) return Undefined(env);
  napi_value result; Check(env, napi_create_array_with_length(env, 6, &result));
  napi_value values[]{Number(env, error.kind), Number(env, error.code), Text(env, error.syscall),
                      Text(env, error.message), Text(env, error.path), error.dest ? Text(env, *error.dest) : Undefined(env)};
  for (unsigned i = 0; i < 6; ++i) { const auto key = std::to_string(i); Own(env, result, key.c_str(), values[i]); }
  return result;
}
template<class F> napi_value Boundary(napi_env env, F callback) {
  try { return callback(); }
  catch (Pending&) { return nullptr; }
  catch (std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
CpDirOptions Options(napi_env env, napi_value* args, bool fresh) {
  return {Boolean(env,args[2]), Boolean(env,args[3]), Boolean(env,args[4]),
          Boolean(env,args[5]), Boolean(env,args[6]), fresh, fresh ? Integer(env,args[7]) : 0};
}
napi_value Sync(napi_env env, napi_callback_info info) {
 return Boundary(env, [&] {
  napi_value args[8]; size_t count = 8; void* data;
  Check(env, napi_get_cb_info(env, info, &count, args, nullptr, &data));
  const auto source = String(env,args[0]), dest = String(env,args[1]);
  switch (reinterpret_cast<uintptr_t>(data)) {
    case 1: return Packet(env, CheckPaths(source,dest,Boolean(env,args[2]),Boolean(env,args[3])));
    case 2: return Packet(env, OverrideFile(source,dest,Integer(env,args[2]),Boolean(env,args[3])));
    default: return Packet(env, CopyDirRecursive(source,dest,dest,Options(env,args,false)));
  }
 });
}
struct Job;
struct Context {
  napi_env env;
  uv_loop_t* loop = nullptr;
  napi_async_cleanup_hook_handle cleanup = nullptr;
  Job* pending = nullptr;
  bool stopping = false;
  explicit Context(napi_env env):env(env) {}
};
struct Job {
  napi_env env;
  std::shared_ptr<Context> context;
  Job* previous = nullptr;
  Job* next = nullptr;
  std::string source, destination;
  CpDirOptions options;
  CpError error;
  napi_async_context async = nullptr;
  uv_work_t work{};
  napi_ref root = nullptr, factory = nullptr;
  bool scheduled = false, completed = false;
  explicit Job(napi_env env, std::shared_ptr<Context> context, std::string source, std::string destination, CpDirOptions options)
      : env(env), context(std::move(context)), source(std::move(source)), destination(std::move(destination)), options(options) {}
  ~Job() {
    if (async) napi_async_destroy(env,async);
    if (root) napi_delete_reference(env,root);
    if (factory) napi_delete_reference(env,factory);
  }
};
void Finalize(napi_env, void* data, void*) { delete static_cast<Job*>(data); }
void Execute(uv_work_t* request) {
  auto* job=static_cast<Job*>(request->data);
  try { job->error=CopyDirRecursive(job->source,job->destination,job->destination,job->options); }
  catch (std::bad_alloc&) { job->error=CpError::Uv(-ENOMEM,"cp",job->destination); }
  catch (std::filesystem::filesystem_error& error) { job->error=CpError::Std(error.code(),job->destination); }
  catch (...) { job->error=CpError::Uv(-EIO,"cp",job->destination); }
}
void FatalPending(napi_env env) {
  // The exception can leave Complete's inner scope before this catch runs.
  // This is fixture-owned HandleScope lifetime, not a runtime workaround.
  napi_handle_scope scope;
  if(napi_open_handle_scope(env,&scope)!=napi_ok)
    napi_fatal_error("copy-directory-component",NAPI_AUTO_LENGTH,"Cannot enter exception HandleScope",NAPI_AUTO_LENGTH);
  struct Close { napi_env env; napi_handle_scope scope; ~Close(){napi_close_handle_scope(env,scope);} } close{env,scope};
  bool pending = false; napi_is_exception_pending(env,&pending);
  if (pending) { napi_value error; napi_get_and_clear_last_exception(env,&error); napi_fatal_exception(env,error); }
}
void Complete(uv_work_t* request,int status) {
  auto* job=static_cast<Job*>(request->data);
  napi_env env=job->env;
  auto context=job->context;
  // A real queued request owns the object until actual completion. No view,
  // pointer or JS handle is accessed by Execute().
  try {
    if (!context->stopping) {
    napi_handle_scope scope; Check(env,napi_open_handle_scope(env,&scope));
    struct Close { napi_env env; napi_handle_scope scope; ~Close(){napi_close_handle_scope(env,scope);} } close{env,scope};
    napi_value owner; Check(env,napi_get_reference_value(env,job->root,&owner));
    if (status == UV_ECANCELED) { job->completed=true; }
    else {
      napi_value argv[3]{Undefined(env),Undefined(env),Undefined(env)}, ignored, factory;
      napi_get_null(env,&argv[0]);
      const char* special=job->error.kind==CpError::kSocket?"socket":job->error.kind==CpError::kFifo?"fifo":job->error.kind==CpError::kUnknown?"unknown":nullptr;
      if (special) { argv[1]=Text(env,special); argv[2]=Text(env,job->error.path); }
      else if(job->error.kind!=CpError::kNone) {
        napi_value packet=Packet(env,job->error);
        Check(env,napi_get_reference_value(env,job->factory,&factory));
        Check(env,napi_call_function(env,owner,factory,1,&packet,&argv[0]));
      }
      napi_value callback; Check(env,napi_get_named_property(env,owner,"ondone",&callback));
      napi_valuetype type; Check(env,napi_typeof(env,callback,&type));
      if(type==napi_function) Check(env,napi_make_callback(env,job->async,owner,callback,3,argv,&ignored));
      job->completed=true;
    }
    }
  } catch(Pending&) { FatalPending(env); }
    catch(std::exception& error) { napi_throw_error(env,nullptr,error.what()); FatalPending(env); }
  if(job->previous) job->previous->next=job->next; else context->pending=job->next;
  if(job->next) job->next->previous=job->previous;
  job->previous=job->next=nullptr;
  napi_async_destroy(env,job->async);job->async=nullptr;
  napi_delete_reference(env,job->factory);job->factory=nullptr;
  job->source.clear();job->destination.clear();job->error={};
  auto root=job->root;job->root=nullptr;
  napi_delete_reference(env,root);
  if(context->stopping&&!context->pending) {
    napi_remove_async_cleanup_hook(context->cleanup);context->cleanup=nullptr;
  }
}
napi_value Create(napi_env env,napi_callback_info info) {
 return Boundary(env,[&] {
  napi_value args[10];size_t count=10;Check(env,napi_get_cb_info(env,info,&count,args,nullptr,nullptr));
  // (prototype, src,dest,force,dereference,errorOnExist,verbatim,preserve,mode,errorFactory)
  std::shared_ptr<Context>* context;
  Check(env,napi_get_instance_data(env,reinterpret_cast<void**>(&context)));
  if((*context)->stopping) { napi_throw_error(env,nullptr,"Copy component environment is closing");throw Pending{}; }
  auto job=std::make_unique<Job>(env,*context,String(env,args[1]),String(env,args[2]),Options(env,args+1,true));
  napi_value owner;Check(env,napi_create_object(env,&owner));
  // N-API lacks SetPrototype. An explicit fixture constructor dependency
  // supplies the real JS prototype through Object.create, before native init.
  napi_value object,global,create,argv[1]{args[0]};
  Check(env,napi_get_global(env,&global));Check(env,napi_get_named_property(env,global,"Object",&object));
  Check(env,napi_get_named_property(env,object,"create",&create));
  Check(env,napi_call_function(env,object,create,1,argv,&owner));
  Check(env,napi_create_reference(env,args[9],1,&job->factory));
  Check(env,napi_type_tag_object(env,owner,&jobTag));
  Check(env,napi_wrap(env,owner,job.get(),Finalize,nullptr,nullptr));
  Job* raw=job.release();
  Check(env,napi_async_init(env,owner,Text(env,"FSREQCALLBACK"),&raw->async));
  return owner;
 });
}
napi_value Run(napi_env env,napi_callback_info info) {
 return Boundary(env,[&] {
  napi_value owner;size_t count=1;Check(env,napi_get_cb_info(env,info,&count,&owner,nullptr,nullptr));
  bool branded=false;Check(env,napi_check_object_type_tag(env,owner,&jobTag,&branded));
  if(!branded) { napi_throw_type_error(env,nullptr,"Invalid copy directory owner");throw Pending{}; }
  Job* job;Check(env,napi_unwrap(env,owner,reinterpret_cast<void**>(&job)));
  if(job->scheduled) { napi_throw_error(env,nullptr,"Copy directory job already scheduled");throw Pending{}; }
  job->scheduled=true;
  bool submitted=false;
  struct Rollback {
    Job* job; bool& submitted;
    ~Rollback() { if(!submitted) {
      if(job->root) { napi_delete_reference(job->env,job->root);job->root=nullptr; }
    }}
  } rollback{job,submitted};
  Check(env,napi_create_reference(env,owner,1,&job->root));
  job->work.data=job;
  int rc=uv_queue_work(job->context->loop,&job->work,Execute,Complete);
  if(rc<0) { napi_throw_error(env,nullptr,uv_strerror(rc));throw Pending{}; }
  job->next=job->context->pending;
  if(job->next)job->next->previous=job;
  job->context->pending=job;
  submitted=true;
  return Undefined(env);
 });
}
napi_value MakeFifo(napi_env env,napi_callback_info info) {
 return Boundary(env,[&] {
  napi_value value;size_t count=1;Check(env,napi_get_cb_info(env,info,&count,&value,nullptr,nullptr));
  const auto path=String(env,value);
  if(::mkfifo(path.c_str(),0600)<0) { napi_throw_error(env,nullptr,std::strerror(errno));throw Pending{}; }
  return Undefined(env);
 });
}
void Cleanup(napi_async_cleanup_hook_handle handle,void* data) {
  auto* context=static_cast<Context*>(data);context->stopping=true;
  for(Job* job=context->pending;job;job=job->next)uv_cancel(reinterpret_cast<uv_req_t*>(&job->work));
  if(!context->pending) { napi_remove_async_cleanup_hook(handle);context->cleanup=nullptr; }
}
void FinalizeContext(napi_env,void* data,void*) { delete static_cast<std::shared_ptr<Context>*>(data); }
napi_value Init(napi_env env,napi_value exports) {
 return Boundary(env,[&] {
  auto context=std::make_shared<Context>(env);
  Check(env,napi_get_uv_event_loop(env,&context->loop));
  auto owner=std::make_unique<std::shared_ptr<Context>>(context);
  Check(env,napi_set_instance_data(env,owner.get(),FinalizeContext,nullptr));owner.release();
  Check(env,napi_add_async_cleanup_hook(env,Cleanup,context.get(),&context->cleanup));
  napi_property_descriptor properties[]{
   {"makeFifo",nullptr,MakeFifo,nullptr,nullptr,nullptr,napi_default_jsproperty,nullptr},
   {"cpSyncCheckPaths",nullptr,Sync,nullptr,nullptr,nullptr,napi_default_jsproperty,reinterpret_cast<void*>(1)},
   {"cpSyncOverrideFile",nullptr,Sync,nullptr,nullptr,nullptr,napi_default_jsproperty,reinterpret_cast<void*>(2)},
   {"cpSyncCopyDir",nullptr,Sync,nullptr,nullptr,nullptr,napi_default_jsproperty,nullptr},
   {"createCpDirJob",nullptr,Create,nullptr,nullptr,nullptr,napi_default_jsproperty,nullptr},
   {"runCpDirJob",nullptr,Run,nullptr,nullptr,nullptr,napi_default_jsproperty,nullptr},
  };
  Check(env,napi_define_properties(env,exports,6,properties));return exports;
 });
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
