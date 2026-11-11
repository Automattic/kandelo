#include "shell/node-upstream/options.h"

#include "mozilla/Assertions.h"

#include <algorithm>
#include <cstring>
#include <utility>

#include "jsapi.h"
#include "jsfriendapi.h"

#include "js/Array.h"
#include "js/CallArgs.h"
#include "js/CharacterEncoding.h"
#include "js/Conversions.h"
#include "js/ErrorReport.h"
#include "js/MapAndSet.h"
#include "js/Object.h"
#include "js/PropertyAndElement.h"
#include "js/Stack.h"
#include "js/Wrapper.h"
#include "shell/node-upstream/options-native-api.h"
#define v8 kandelo_node_options_api
#define node kandelo_node_options_impl
#include "shell/node-upstream/options-upstream/node_options.h"
#undef node
#undef v8

#include "shell/node-upstream/per-context.h"
#include "shell/node-upstream/realm.h"
#include "vm/JSAtomUtils.h"
#include "vm/JSFunction.h"
#include "vm/StringType.h"


namespace n = kandelo_node_options_impl;
namespace kandelo_node_options_api {
namespace {
struct NativeOptions {
  std::shared_ptr<n::PerIsolateOptions> isolate = n::per_process::cli_options->per_isolate;
  std::shared_ptr<n::EnvironmentOptions> environment = isolate->per_env;
  bool serialized = false;
  bool configured = false;
  bool failed = false;
  // Actual default embedding policy: the full principal bootstrap is selected,
  // and this embedding has registered no preload callback or policy overrides.
  bool noEsmLoader = false;
  bool noGlobalSearchPaths = false;
  bool noBrowserGlobals = false;
  void* preload = nullptr;
  n::StringVector arguments, execArguments, engineArguments;
};
using Callback = void (*)(const FunctionCallbackInfo<Value>&);
std::vector<Callback> callbacks;
n::StringVector invocation;
bool nodeInvocation = false;
void Finalize(JS::GCContext*, JSObject* object) {
  const auto value = JS::GetReservedSlot(object, 0);
  if (!value.isUndefined()) delete static_cast<NativeOptions*>(value.toPrivate());
}
const JSClassOps stateOps = {nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,Finalize};
const JSClass stateClass = {"NodeOptionsState",JSCLASS_HAS_RESERVED_SLOTS(1)|JSCLASS_FOREGROUND_FINALIZE,&stateOps};
bool Error(JSContext* cx, const char* code, const char* text) {
  if (JS_IsExceptionPending(cx)) return false;
  JS::RootedObject stack(cx); if (!JS::CaptureCurrentStack(cx,&stack)) return false;
  JS::RootedString filename(cx,JS_NewStringCopyZ(cx,"")), message(cx,JS_NewStringCopyZ(cx,text));
  JS::Rooted<mozilla::Maybe<JS::Value>> cause(cx,mozilla::Nothing()); JS::RootedValue error(cx);
  if (!filename || !message || !JS::CreateError(cx,JSEXN_ERR,stack,filename,0,JS::ColumnNumberOneOrigin(1),nullptr,message,cause,&error)) return false;
  if (code) {
    JS::RootedObject object(cx,&error.toObject()); JS::RootedString value(cx,JS_NewStringCopyZ(cx,code));
    if (!value || !JS_DefineProperty(cx,object,"code",value,JSPROP_ENUMERATE)) return false;
  }
  JS_SetPendingException(cx,error); return false;
}
NativeOptions* Data(JSContext* cx, JS::HandleObject realm) {
  JS::RootedObject runtime(cx,kandelo::node::GetRealmRuntime(cx,realm)); if (!runtime) return nullptr;
  JS::RootedObject state(cx,kandelo::node::GetRuntimeOptionsState(cx,runtime,true)); if (!state) return nullptr;
  JS::RootedObject raw(cx,js::CheckedUnwrapDynamic(state,cx,false));
  if (!raw || JS::GetClass(raw)!=&stateClass) { Error(cx,nullptr,"Native options owner access denied"); return nullptr; }
  auto* data=static_cast<NativeOptions*>(JS::GetReservedSlot(raw,0).toPrivate());
  if (data->failed) { Error(cx,nullptr,"Previous native options configuration failed"); return nullptr; }
  return data;
}
}
struct Cell {
  JS::PersistentRootedValue value;
  Cell(JSContext* cx,JS::HandleValue input):value(cx,input) {}
};
struct Frame {
  JSContext* cx;
  JS::RootedObject realm;
  NativeOptions* data;
  JS::CallArgs* arguments;
  std::vector<std::unique_ptr<Value>> roots;
  n::Environment environment;
  Isolate isolate;
  Frame* previous;
  inline static thread_local Frame* current = nullptr;
  Frame(JSContext* cx,JS::HandleObject owner,NativeOptions* data,JS::CallArgs* args=nullptr)
      :cx(cx),realm(cx,owner),data(data),arguments(args),environment(this),isolate(this),previous(current) { current=this; }
  ~Frame() { current=previous; }
  template<class T> Local<T> Own(JS::HandleValue value) {
    if (JS_IsExceptionPending(cx)) return {};
    auto object=std::make_unique<T>(std::make_unique<Cell>(cx,value)); auto* pointer=object.get();
    roots.push_back(std::move(object)); return Local<T>(pointer);
  }
};
Value::Value(std::unique_ptr<Cell> cell):cell_(std::move(cell)) {}
Value::~Value() = default;
Cell& Value::cell() const { MOZ_RELEASE_ASSERT(cell_); return *cell_; }
static JS::HandleValue Input(Local<Value> value) { MOZ_RELEASE_ASSERT(!value.IsEmpty()); return value->cell().value; }
Local<Value> FrameArgument(Isolate* isolate,int index) {
  auto& f=isolate->frame(); MOZ_RELEASE_ASSERT(f.arguments);
  JS::RootedValue value(f.cx,f.arguments->get(index)); return f.Own<Value>(value);
}
void SetFrameReturn(Isolate* isolate,Local<Value> value) {
  auto& f=isolate->frame(); MOZ_RELEASE_ASSERT(f.arguments);
  if (!value.IsEmpty() && !JS_IsExceptionPending(f.cx)) f.arguments->rval().set(Input(value));
}
Local<Value> Null(Isolate* isolate) { JS::RootedValue value(isolate->frame().cx,JS::NullValue()); return isolate->frame().Own<Value>(value); }
Local<Value> Undefined(Isolate* isolate) { JS::RootedValue value(isolate->frame().cx,JS::UndefinedValue()); return isolate->frame().Own<Value>(value); }
MaybeLocal<String> String::NewFromUtf8(Isolate* isolate,const char* text,NewStringType,int length) {
  auto& f=isolate->frame(); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedString string(f.cx,JS_NewStringCopyUTF8N(f.cx,JS::UTF8Chars(text,size_t(length)))); if (!string) return {};
  JS::RootedValue value(f.cx,JS::StringValue(string)); return f.Own<String>(value);
}
Local<Boolean> Boolean::New(Isolate* isolate,bool input) { auto& f=isolate->frame(); JS::RootedValue value(f.cx,JS::BooleanValue(input)); return f.Own<Boolean>(value); }
Local<Number> Number::New(Isolate* isolate,double input) { auto& f=isolate->frame(); JS::RootedValue value(f.cx,JS::DoubleValue(input)); return f.Own<Number>(value); }
Local<Integer> Integer::New(Isolate* isolate,int input) { auto& f=isolate->frame(); JS::RootedValue value(f.cx,JS::Int32Value(input)); return f.Own<Integer>(value); }
Local<Object> Object::New(Isolate* isolate) {
  auto& f=isolate->frame(); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject object(f.cx,JS_NewPlainObject(f.cx)); if (!object) return {};
  JS::RootedValue value(f.cx,JS::ObjectValue(*object)); return f.Own<Object>(value);
}
Local<Object> Object::New(Isolate* isolate,Local<Value> prototype,Local<Name>* keys,Local<Value>* entries,size_t count) {
  auto& f=isolate->frame(); if (JS_IsExceptionPending(f.cx)) return {};
  MOZ_RELEASE_ASSERT(Input(prototype).isNull()); JS::RootedObject nullPrototype(f.cx),object(f.cx,JS_NewObjectWithGivenProto(f.cx,nullptr,nullPrototype));
  if (!object) return {};
  for (size_t i=0;i<count;i++) {
    JS::RootedId key(f.cx); JS::RootedValue name(f.cx,Input(keys[i])),entry(f.cx,Input(entries[i]));
    if (!JS_ValueToId(f.cx,name,&key) || !JS_DefinePropertyById(f.cx,object,key,entry,JSPROP_ENUMERATE)) return {};
  }
  JS::RootedValue value(f.cx,JS::ObjectValue(*object)); return f.Own<Object>(value);
}
Maybe<bool> Object::SetPrototypeV2(Local<Context> context,Local<Value> prototype) {
  auto& f=context->isolate->frame(); JS::RootedObject object(f.cx,&cell().value.toObject()),parent(f.cx);
  if (Input(prototype).isObject()) parent=&Input(prototype).toObject(); else MOZ_RELEASE_ASSERT(Input(prototype).isNull());
  if (!JS_SetPrototype(f.cx,object,parent)) return {}; return Maybe<bool>(true);
}
Maybe<bool> Object::Set(Local<Context> context,Local<Value> name,Local<Value> entry) {
  auto& f=context->isolate->frame(); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject object(f.cx,&cell().value.toObject()); JS::RootedId key(f.cx);
  JS::RootedValue property(f.cx,Input(name)),value(f.cx,Input(entry));
  if (!JS_ValueToId(f.cx,property,&key) || !JS_SetPropertyById(f.cx,object,key,value)) return {}; return Maybe<bool>(true);
}
Local<Map> Map::New(Isolate* isolate) {
  auto& f=isolate->frame(); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject object(f.cx,JS::NewMapObject(f.cx)); if (!object) return {};
  JS::RootedValue value(f.cx,JS::ObjectValue(*object)); return f.Own<Map>(value);
}
MaybeLocal<Map> Map::Set(Local<Context> context,Local<Value> key,Local<Value> entry) {
  auto& f=context->isolate->frame(); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject object(f.cx,&cell().value.toObject()); JS::RootedValue name(f.cx,Input(key)),value(f.cx,Input(entry));
  if (!JS::MapSet(f.cx,object,name,value)) return {}; return Local<Map>(this);
}
// Supplied inputs are owned by the caller's guest process or privileged control.
// The complete original C++ parser owns all option field mutations and checks.
static bool ParseProfile(Frame& f,const n::StringVector& input,const std::string& environment) {
  auto* data=f.data;
  if (data->configured || data->serialized) return Error(f.cx,nullptr,"Native options profile has already been configured");
  if (input.empty()) return Error(f.cx,nullptr,"Native options arguments require a program name");
  n::Mutex::ScopedLock lock(n::per_process::cli_options_mutex);
  auto options=std::make_shared<n::PerProcessOptions>(); n::per_process::cli_options=options;
  data->isolate=options->per_isolate; data->environment=data->isolate->per_env;
  n::HandleEnvOptions(data->environment);
  n::StringVector errors,env=n::ParseNodeOptionsEnvVar(environment,&errors);
  data->arguments=input; data->execArguments.clear(); data->engineArguments.clear();
  if (errors.empty() && !env.empty()) {
    env.insert(env.begin(),input[0]);
    n::options_parser::Parse(&env,nullptr,&data->engineArguments,options.get(),n::kAllowedInEnvvar,&errors);
  }
  if (errors.empty() && !JS_IsExceptionPending(f.cx))
    n::options_parser::Parse(&data->arguments,&data->execArguments,&data->engineArguments,options.get(),n::kDisallowedInEnvvar,&errors);
  if (errors.empty() && !JS_IsExceptionPending(f.cx)) {
    data->environment->CheckBenchOptions(&errors);
    options->CheckProcessTimeoutOptions(&errors,data->arguments);
  }
  data->configured=true;
  if (JS_IsExceptionPending(f.cx)) { data->failed=true; return false; }
  if (!errors.empty()) { data->failed=true; return Error(f.cx,nullptr,errors[0].c_str()); }
  // V8's flag application and Node's outer config-file/security machinery are
  // separate native dependencies. Reject requests until their owning backend
  // exists; storing an option must never pretend to apply it successfully.
  bool configFileRequested=false;
  for (auto argument:data->execArguments) {
    const auto equals=argument.find('='); if (equals!=std::string::npos) argument.resize(equals);
    std::replace(argument.begin(),argument.end(),'_','-');
    if (argument=="--experimental-default-config-file") configFileRequested=true;
  }
  if (configFileRequested || data->engineArguments.size()>1 || !options->disable_proto.empty() || !options->security_reverts.empty() ||
      !data->environment->env_file.empty() || !data->environment->optional_env_file.empty() || !data->environment->config_file_path.empty()) {
    data->failed=true; return Error(f.cx,"ERR_KANDELO_NOT_IMPLEMENTED","Requested native engine/config/security option adoption is not implemented");
  }
  return true;
}

static bool Invoke(JSContext* cx,unsigned argc,JS::Value* vp) {
  auto args=JS::CallArgsFromVp(argc,vp); JS::RootedObject realm(cx,&js::GetFunctionNativeReserved(&args.callee(),0).toObject());
  if (!kandelo::node::CheckRealmLibraryActive(cx,realm)) return false;
  auto* data=Data(cx,realm); if (!data) return false;
  const auto index=js::GetFunctionNativeReserved(&args.callee(),1).toInt32(); MOZ_RELEASE_ASSERT(index>=0 && size_t(index)<callbacks.size());
  Frame frame(cx,realm,data,&args); FunctionCallbackInfo<Value> call(&frame.isolate); callbacks[index](call); return !JS_IsExceptionPending(cx);
}
}
namespace kandelo_node_options_impl {
using namespace kandelo_node_options_api;
std::shared_ptr<PerIsolateOptions> IsolateData::options() const { return frame_->data->isolate; }
Environment* Environment::GetCurrent(Local<Context> context) { return &context->isolate->frame().environment; }
Environment* Environment::GetCurrent(const FunctionCallbackInfo<Value>& args) { return &args.GetIsolate()->frame().environment; }
Isolate* Environment::isolate() { return &frame_->isolate; }
bool Environment::has_run_bootstrapping_code() const {
  JS::RootedObject runtime(frame_->cx,kandelo::node::GetRealmRuntime(frame_->cx,frame_->realm)); if (!runtime) return false;
  JS::RootedObject principal(frame_->cx,kandelo::node::GetRuntimePrincipalRealm(frame_->cx,runtime));
  return principal && kandelo::node::HasCompletedNodeBootstrap(frame_->cx,principal);
}
void Environment::set_has_serialized_options(bool value) { frame_->data->serialized=value; }
std::shared_ptr<EnvironmentOptions> Environment::options() { return frame_->data->environment; }
IsolateData* Environment::isolate_data() { return &isolate_data_; }
Local<Value> Environment::primordials_safe_map_prototype_object() {
  JS::RootedObject object(frame_->cx,kandelo::node::GetRealmSafeMapPrototype(frame_->cx,frame_->realm)); if (!object) return {};
  JS::RootedValue value(frame_->cx,JS::ObjectValue(*object)); return frame_->Own<Object>(value);
}
#define NAME(method,text) Local<Name> Environment::method() { return String::NewFromUtf8Literal(isolate(),text); }
NAME(host_string,"host") NAME(port_string,"port") NAME(help_text_string,"helpText")
NAME(env_var_settings_string,"envVarSettings") NAME(type_string,"type") NAME(default_is_true_string,"defaultIsTrue")
NAME(options_string,"options") NAME(aliases_string,"aliases")
#undef NAME
bool Environment::should_not_register_esm_loader() { return frame_->data->noEsmLoader; }
bool Environment::no_global_search_paths() { return frame_->data->noGlobalSearchPaths; }
bool Environment::no_browser_globals() { return frame_->data->noBrowserGlobals; }
void* Environment::embedder_preload() { return frame_->data->preload; }
void Environment::ThrowError(const char* text) { kandelo_node_options_api::Error(frame_->cx,nullptr,text); }
Utf8Value::Utf8Value(Isolate* isolate,Local<Value> value) {
  auto& frame=isolate->frame(); if (JS_IsExceptionPending(frame.cx) || value.IsEmpty()) return;
  JS::RootedString string(frame.cx,JS::ToString(frame.cx,kandelo_node_options_api::Input(value))); if (!string) return;
  JS::Rooted<JSLinearString*> linear(frame.cx,string->ensureLinear(frame.cx)); if (!linear) return;
  auto bytes=JS_EncodeStringToUTF8(frame.cx,string); if (!bytes) return;
  value_.assign(bytes.get(),JS::GetDeflatedUTF8StringLength(linear));
}
const char* Utf8Value::operator*() const { return value_.c_str(); }
size_t Utf8Value::length() const { return value_.size(); }
MaybeLocal<Value> ToV8Value(Local<Context> context,const std::string& input) {
  Local<String> string; if (!String::NewFromUtf8(context->isolate,input.data(),NewStringType::kNormal,int(input.size())).ToLocal(&string)) return {};
  return Local<Value>(string);
}
MaybeLocal<Value> ToV8Value(Local<Context> context,const StringVector& inputs) {
  auto& f=context->isolate->frame(); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject array(f.cx,JS::NewArrayObject(f.cx,inputs.size())); if (!array) return {};
  for (size_t i=0;i<inputs.size();i++) { Local<Value> value; if (!ToV8Value(context,inputs[i]).ToLocal(&value)) return {}; JS::RootedValue item(f.cx,kandelo_node_options_api::Input(value)); if (!JS_DefineElement(f.cx,array,i,item,JSPROP_ENUMERATE)) return {}; }
  JS::RootedValue value(f.cx,JS::ObjectValue(*array)); return Local<Value>(f.Own<Object>(value));
}
MaybeLocal<Value> ToV8Value(Local<Context> context,const std::unordered_map<std::string,StringVector>& inputs) {
  auto map=Map::New(context->isolate); if (map.IsEmpty()) return {};
  for (const auto& [name,values]:inputs) { Local<Value> key,value; if (!ToV8Value(context,name).ToLocal(&key) || !ToV8Value(context,values).ToLocal(&value) || map->Set(context,key,value).IsEmpty()) return {}; }
  return Local<Value>(map);
}
void SetMethodNoSideEffect(Local<Context> context,Local<Object> target,const char* name,void(*callback)(const FunctionCallbackInfo<Value>&)) {
  auto& f=context->isolate->frame(); if (JS_IsExceptionPending(f.cx)) return;
  auto found=std::find(kandelo_node_options_api::callbacks.begin(),kandelo_node_options_api::callbacks.end(),callback);
  if (found==kandelo_node_options_api::callbacks.end()) { kandelo_node_options_api::callbacks.push_back(callback); found=kandelo_node_options_api::callbacks.end()-1; }
  JS::RootedFunction function(f.cx,js::NewFunctionWithReserved(f.cx,kandelo_node_options_api::Invoke,0,0,"")); if (!function) return;
  JS::RootedObject object(f.cx,JS_GetFunctionObject(function)),binding(f.cx,&target->cell().value.toObject());
  js::SetFunctionNativeReserved(object,0,JS::ObjectValue(*f.realm));
  js::SetFunctionNativeReserved(object,1,JS::Int32Value(int32_t(found-kandelo_node_options_api::callbacks.begin())));
  JS::RootedValue value(f.cx,JS::ObjectValue(*object));
  MOZ_RELEASE_ASSERT(JS_SetProperty(f.cx,binding,name,value),"Original native options method property invariant");
  // V8 SetName updates its internal name after Set, even when an inherited
  // setter intercepted the assignment. Do not bypass that actual operation.
  // A resolved/redefined name needs additional engine tracking; fail honestly
  // rather than overwrite a user property or publish an incorrect name.
  MOZ_RELEASE_ASSERT(!function->hasResolvedName(),"Native option method late naming after inspection is not implemented");
  JS::Rooted<JSAtom*> atom(f.cx,js::Atomize(f.cx,name,std::strlen(name)));
  MOZ_RELEASE_ASSERT(atom,"Original native options method name invariant");
  function->setAtom(atom);
}
namespace credentials {
bool SafeGetenv(const char* name,std::string* value) { const char* text=secure_getenv(name); if (!text) return false; *value=text; return true; }
}
}
namespace kandelo_options_adapter {
using namespace kandelo_node_options_api;
void ThrowOptionsBeforeBootstrap(Isolate* isolate,const char* text) { Error(isolate->frame().cx,"ERR_OPTIONS_BEFORE_BOOTSTRAPPING",text); }
void DefineConstant(Local<Object> target,const char* name,double number) {
  auto& f=*Frame::current; if (JS_IsExceptionPending(f.cx)) return;
  JS::RootedObject object(f.cx,&target->cell().value.toObject()); JS::RootedValue value(f.cx,JS::DoubleValue(number));
  MOZ_RELEASE_ASSERT(JS_DefineProperty(f.cx,object,name,value,JSPROP_ENUMERATE|JSPROP_READONLY|JSPROP_PERMANENT),"Original Node options constant invariant");
}
uint64_t UnavailableMemoryQuery() {
  MOZ_RELEASE_ASSERT(Frame::current);
  Error(Frame::current->cx,"ERR_KANDELO_NOT_IMPLEMENTED","Native options memory query requires real libuv memory accounting");
  // Failure transport only: pending exception is preserved and no value is
  // serialized or accepted as a successful configuration.
  return 0;
}
}
namespace kandelo::node {
using namespace kandelo_node_options_api;
JSObject* CreateOptionsState(JSContext* cx) {
  JS::RootedObject object(cx,JS_NewObject(cx,&stateClass)); if (!object) return nullptr;
  JS::SetReservedSlot(object,0,JS::PrivateValue(new NativeOptions())); return object;
}
bool InitializeOptionsForRealm(JSContext* cx,JS::HandleObject realm) {
  if (!nodeInvocation) return true;
  auto* data=Data(cx,realm); if (!data) return false;
  if (data->configured) return true;
  Frame frame(cx,realm,data); std::string input;
  n::credentials::SafeGetenv("NODE_OPTIONS",&input);
  return ParseProfile(frame,invocation,input);
}
JSObject* CreateOptionsBinding(JSContext* cx,JS::HandleObject realm) {
  auto* data=Data(cx,realm); if (!data) return nullptr;
  Frame frame(cx,realm,data);
  auto object=Object::New(&frame.isolate); if (object.IsEmpty()) return nullptr;
  kandelo_options_adapter::initializer(object,Undefined(&frame.isolate),frame.isolate.GetCurrentContext(),nullptr);
  if (JS_IsExceptionPending(cx)) return nullptr; return &object->cell().value.toObject();
}
JSObject* InspectOptionsState(JSContext* cx,JS::HandleObject runtime) {
  JS::RootedObject state(cx,GetRuntimeOptionsState(cx,runtime,true)); if (!state) return nullptr;
  JS::RootedObject raw(cx,js::CheckedUnwrapDynamic(state,cx,false)); if (!raw) return nullptr;
  MOZ_RELEASE_ASSERT(JS::GetClass(raw)==&stateClass);
  auto* data=static_cast<NativeOptions*>(JS::GetReservedSlot(raw,0).toPrivate());
  JS::RootedObject snapshot(cx,JS_NewPlainObject(cx)); if (!snapshot) return nullptr;
  auto flag=[&](const char* name,bool input) { JS::RootedValue value(cx,JS::BooleanValue(input)); return JS_DefineProperty(cx,snapshot,name,value,JSPROP_ENUMERATE); };
  if (!flag("configured",data->configured) || !flag("serialized",data->serialized) || !flag("failed",data->failed) ||
      !flag("nodeInvocation",nodeInvocation) || !flag("warnings",data->environment->warnings) || !flag("pendingDeprecation",data->environment->pending_deprecation)) return nullptr;
  return snapshot;
}
bool ConfigureOptions(JSContext* cx,JS::HandleObject realm,JS::HandleObject arguments,JS::HandleString environmentOptions) {
  if (!CheckRealmLibraryActive(cx,realm)) return false;
  auto* data=Data(cx,realm); if (!data) return false; Frame frame(cx,realm,data);
  uint32_t length; if (!JS::GetArrayLength(cx,arguments,&length)) return false;
  n::StringVector inputs;
  for (uint32_t i=0;i<length;i++) {
    JS::RootedValue input(cx); if (!JS_GetElement(cx,arguments,i,&input)) return false;
    if (!input.isString()) return Error(cx,nullptr,"Native options arguments must contain strings");
    auto value=frame.Own<Value>(input); n::Utf8Value text(&frame.isolate,value);
    if (JS_IsExceptionPending(cx)) return false;
    std::string item(*text,text.length()); if (item.find('\0')!=std::string::npos) return Error(cx,nullptr,"Native options arguments cannot contain NUL bytes");
    inputs.push_back(std::move(item));
  }
  JS::RootedValue input(cx,JS::StringValue(environmentOptions)); auto value=frame.Own<Value>(input); n::Utf8Value text(&frame.isolate,value);
  if (JS_IsExceptionPending(cx)) return false;
  std::string environment(*text,text.length()); if (environment.find('\0')!=std::string::npos) return Error(cx,nullptr,"Native options environment cannot contain NUL bytes");
  return ParseProfile(frame,inputs,environment);
}
void CaptureOptionsInvocation(int argc,char** argv,bool mode) {
  invocation.clear(); for (int i=0;i<argc;i++) invocation.emplace_back(argv[i]); nodeInvocation=mode;
}
bool ReadNativeTracingConfiguration(JSContext* cx,JS::HandleObject realm,
                                    NativeTracingConfiguration* result) {
  if (!CheckRealmLibraryActive(cx,realm) || !Data(cx,realm)) return false;
  n::Mutex::ScopedLock lock(n::per_process::cli_options_mutex);
  const auto& options=n::per_process::cli_options;
  result->filePattern=options->trace_event_file_pattern;
  result->categories=options->trace_event_categories;
  result->permissionsEnabled=options->per_isolate->per_env->permission;
  return true;
}
}
