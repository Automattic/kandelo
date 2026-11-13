#ifndef KANDELO_NODE_OPTIONS_H
#define KANDELO_NODE_OPTIONS_H
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "js/TypeDecls.h"
namespace kandelo_node_options_impl {class EnvironmentOptions;class PerIsolateOptions;}
namespace kandelo::node {
std::shared_ptr<kandelo_node_options_impl::PerIsolateOptions> BorrowNativeIsolateOptions(JSContext*,JS::HandleObject);
std::shared_ptr<kandelo_node_options_impl::EnvironmentOptions> BorrowNativeEnvironmentOptions(JSContext*,JS::HandleObject);
struct NativeTracingConfiguration {
  std::string filePattern, categories;
  bool permissionsEnabled = false;
};
struct NativeEnvironmentFlags {
  bool zeroFill,pendingDeprecation,traceEnv,traceEnvJsStack,traceEnvNativeStack,traceUncaught,extraInfoOnFatal,reportOnFatal;
};
NativeEnvironmentFlags ReadProcessEnvironmentFlags();
bool ReadEnvironmentFlags(JSContext*,JS::HandleObject,NativeEnvironmentFlags*);
bool ReadNativeTracingConfiguration(JSContext* cx, JS::HandleObject realm,
                                    NativeTracingConfiguration* result);
bool NativeAsyncContextFrameEnabled();
bool NativeZeroFillBuffersEnabled();
uint16_t NativeInspectorPort();
void SetNativeInspectorPort(uint16_t);
// Borrow only a successfully parsed invocation. The retaining runtime owns the
// immutable native options record until its Environment has shut down.
bool BorrowNativeInvocation(JSContext*,JS::HandleObject,
                            const std::vector<std::string>** arguments,
                            const std::vector<std::string>** execArguments);
JSObject* CreateOptionsState(JSContext* cx);
bool InitializeOptionsForRealm(JSContext* cx, JS::HandleObject realm);
JSObject* CreateOptionsBinding(JSContext* cx, JS::HandleObject realm);
JSObject* InspectOptionsState(JSContext* cx, JS::HandleObject runtime);
bool ConfigureOptions(JSContext* cx, JS::HandleObject realm, JS::HandleObject arguments,
                      JS::HandleString environmentOptions);
void CaptureOptionsInvocation(int argc, char** argv, bool nodeMode);
}
#endif
