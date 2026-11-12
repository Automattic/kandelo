#ifndef KANDELO_NODE_PROCESS_FILES_NATIVE_API_H
#define KANDELO_NODE_PROCESS_FILES_NATIVE_API_H
#include <optional>
#include <ranges>
#include <unordered_map>
#include "shell/node-upstream/process-native-api.h"
namespace ada {struct url_aggregator;}
namespace kandelo_node_codec_api {
class Boolean:public Value {public:using Value::Value;static Local<Boolean> New(Isolate*,bool);bool Value()const;};
enum class Intercepted{kNo,kYes};
enum class PropertyHandlerFlags{kHasNoSideEffect};
struct NamedPropertyHandlerConfiguration {
 template<class... Args> explicit NamedPropertyHandlerConfiguration(Args&&...);
};
struct IndexedPropertyHandlerConfiguration {
 template<class... Args> explicit IndexedPropertyHandlerConfiguration(Args&&...);
};
class PropertyDescriptor {
 public:
 bool has_value()const;bool has_writable()const;bool has_enumerable()const;bool has_configurable()const;
 bool configurable()const;bool enumerable()const;bool writable()const;bool has_get()const;bool has_set()const;
 Local<Value> value()const;
};
}
namespace kandelo_node_codec_impl {
// Native store interface only. All store/copy/environment algorithms are in
// complete original node_env_var.cc, not duplicated in this API bridge.
class KVStore {
 public:
 KVStore()=default;virtual ~KVStore()=default;
 KVStore(const KVStore&)=delete;KVStore& operator=(const KVStore&)=delete;
 virtual MaybeLocal<String> Get(Isolate*,Local<String>)const=0;
 virtual std::optional<std::string> Get(const char*)const=0;
 virtual void Set(Isolate*,Local<String>,Local<String>)=0;
 virtual int32_t Query(Isolate*,Local<String>)const=0;
 virtual int32_t Query(const char*)const=0;
 virtual void Delete(Isolate*,Local<String>)=0;
 virtual MaybeLocal<Array> Enumerate(Isolate*)const=0;
 virtual MaybeLocal<Array> Pairs(Isolate*)const;
 virtual std::shared_ptr<KVStore> Clone(Isolate*)const;
 virtual Maybe<void> AssignFromObject(Local<Context>,Local<Object>);
 Maybe<void> AssignToObject(Isolate*,Local<Context>,Local<Object>);
 static std::shared_ptr<KVStore> CreateMapKVStore();
};
struct NativeEnvOptions {bool pending_deprecation,trace_env,trace_env_js_stack,trace_env_native_stack,trace_uncaught,extra_info_on_fatal_exception;};
struct NativeEnvIsolateOptions {std::shared_ptr<NativeEnvOptions> per_env;};
namespace per_process {
 extern std::shared_ptr<KVStore> system_environment;
}
void DumpNativeBacktrace(FILE*);void DumpJavaScriptBacktrace(FILE*);
Maybe<void> ProcessEmitDeprecationWarning(Environment*,const char*,const char*);
Local<String> Uint32ToString(Local<Context>,uint32_t);
namespace url {std::optional<std::string> FileURLToPath(Environment*,const ada::url_aggregator&);}
// Value-mode native handle storage; uses the actual typed/rooted engine vector.
template<size_t N> class MaybeStackBuffer<Value,N> {
 Isolate* isolate_;LocalVector<Value> values_;size_t length_;
 public:
 MaybeStackBuffer(Isolate* isolate,size_t count):isolate_(isolate),values_(isolate,count),length_(count){}
 auto operator[](size_t index){return values_[index];}
 void SetLength(size_t length){if(length>values_.size())Crash("Native value buffer length");length_=length;}
 Local<Array> ToArray()const{return Array::New(isolate_,values_.data(),length_);}
};
}
#endif
