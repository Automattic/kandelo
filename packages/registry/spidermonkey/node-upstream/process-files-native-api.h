#ifndef KANDELO_NODE_PROCESS_FILES_NATIVE_API_H
#define KANDELO_NODE_PROCESS_FILES_NATIVE_API_H
#include <optional>
#include <ranges>
#include <unordered_map>
#include "shell/node-upstream/process-native-api.h"
namespace ada {struct url_aggregator;}
namespace kandelo_node_codec_api {
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
namespace per_process {
 extern std::shared_ptr<KVStore> system_environment;
}
void DumpNativeBacktrace(FILE*);void DumpJavaScriptBacktrace(FILE*);
Maybe<void> ProcessEmitDeprecationWarning(Environment*,const char*,const char*);
namespace url {std::optional<std::string> FileURLToPath(Environment*,const ada::url_aggregator&);}
}
#endif
