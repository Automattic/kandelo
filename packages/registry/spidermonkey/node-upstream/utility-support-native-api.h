#ifndef KANDELO_NODE_UTILITY_SUPPORT_NATIVE_API_H
#define KANDELO_NODE_UTILITY_SUPPORT_NATIVE_API_H
#include <ctime>
#include "shell/node-upstream/process-native-api.h"
namespace kandelo_node_codec_api {
class Platform {
 public:void RegisterIsolate(Isolate*,uv_loop_t*);void DisposeIsolate(Isolate*);
};
class JSON {public:static MaybeLocal<String> Stringify(Local<Context>,Local<Value>);};
}
namespace kandelo_node_codec_impl {
class SnapshotBuilder {public:static void InitializeIsolateParams(const SnapshotData*,Isolate::CreateParams*);};
class UtilityPlatformAccess {public:kandelo_node_codec_api::Platform* Platform();};
namespace per_process {extern UtilityPlatformAccess v8_platform;}
}
#endif
