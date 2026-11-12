#ifndef KANDELO_NODE_OPTIONS_H
#define KANDELO_NODE_OPTIONS_H
#include <string>
#include <cstdint>
#include <vector>

#include "js/TypeDecls.h"
namespace kandelo::node {
struct NativeTracingConfiguration {
  std::string filePattern, categories;
  bool permissionsEnabled = false;
};
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
