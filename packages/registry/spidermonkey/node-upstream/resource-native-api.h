#ifndef KANDELO_NODE_RESOURCE_NATIVE_API_H
#define KANDELO_NODE_RESOURCE_NATIVE_API_H
// Consumed interfaces for the complete original resource units. Missing
// backends remain undefined; importing a unit does not activate its binding.
#include <functional>
#include <openssl/opensslv.h>
#include <variant>
#include "node-async-metadata.generated.h"
#include "shell/node-upstream/build-profile.h"
#include "shell/node-upstream/codec-native-api.h"
#define node kandelo_node_codec_impl
#define v8 kandelo_node_codec_api
#include "shell/node-upstream/codecs-upstream/aliased_buffer.h"
#include "shell/node-upstream/resource-upstream/async_wrap.h"
#undef v8
#undef node
namespace kandelo_node_codec_impl {
// The original provider enum and existing canonical JS inventory must use the
// same actual OpenSSL selection, despite their distinct preprocessor guards.
static_assert(size_t(AsyncWrap::PROVIDERS_LENGTH)==
              sizeof(kandelo::node::asyncmeta::kProviders)/sizeof(kandelo::node::asyncmeta::kProviders[0]));
class AsyncHooks {
 public:
  using Fields=kandelo::node::asyncmeta::Field;
#define KANDELO_ASYNC_FIELD(name) static constexpr Fields name=kandelo::node::asyncmeta::name;
  KANDELO_ASYNC_FIELD(kInit) KANDELO_ASYNC_FIELD(kBefore)
  KANDELO_ASYNC_FIELD(kAfter) KANDELO_ASYNC_FIELD(kDestroy)
  KANDELO_ASYNC_FIELD(kPromiseResolve) KANDELO_ASYNC_FIELD(kTotals)
  KANDELO_ASYNC_FIELD(kCheck) KANDELO_ASYNC_FIELD(kStackLength)
  KANDELO_ASYNC_FIELD(kUsesExecutionAsyncResource) KANDELO_ASYNC_FIELD(kFieldsCount)
#undef KANDELO_ASYNC_FIELD
  using UidFields=kandelo::node::asyncmeta::UidField;
#define KANDELO_ASYNC_UID(name) static constexpr UidFields name=kandelo::node::asyncmeta::name;
  KANDELO_ASYNC_UID(kExecutionAsyncId) KANDELO_ASYNC_UID(kTriggerAsyncId)
  KANDELO_ASYNC_UID(kAsyncIdCounter) KANDELO_ASYNC_UID(kDefaultTriggerAsyncId)
  KANDELO_ASYNC_UID(kUidFieldsCount)
#undef KANDELO_ASYNC_UID
  AliasedUint32Array& fields();AliasedFloat64Array& async_id_fields();
  AliasedFloat64Array& async_ids_stack();Local<Array> js_execution_async_resources();
  Local<Object> native_execution_async_resource(size_t);Local<Array> GetPromiseHooks(Isolate*)const;
  void push_async_context(double,double,std::variant<Local<Object>*,Global<Object>*>);
  bool pop_async_context(double);void clear_async_id_stack();Local<String> provider_string(int);
};
struct async_context {double async_id;double trigger_async_id;};
MaybeLocal<Value> InternalMakeCallback(Environment*,Local<Object>,Local<Object>,Local<Function>,int,Local<Value>*,async_context,Local<Value>);

}
namespace kandelo_async_resource_adapter {
using namespace kandelo_node_codec_api;
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
using IsolateInitializer=void(*)(kandelo_node_codec_impl::IsolateData*,Local<ObjectTemplate>);
extern Initializer initializer;
extern IsolateInitializer isolate_initializer;
}
#endif
