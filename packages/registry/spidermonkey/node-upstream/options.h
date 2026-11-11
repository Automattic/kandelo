#ifndef KANDELO_NODE_OPTIONS_H
#define KANDELO_NODE_OPTIONS_H
#include <string>

#include "js/TypeDecls.h"
namespace kandelo::node {
struct NativeTracingConfiguration {
  std::string filePattern, categories;
  bool permissionsEnabled = false;
};
bool ReadNativeTracingConfiguration(JSContext* cx, JS::HandleObject realm,
                                    NativeTracingConfiguration* result);
JSObject* CreateOptionsState(JSContext* cx);
bool InitializeOptionsForRealm(JSContext* cx, JS::HandleObject realm);
JSObject* CreateOptionsBinding(JSContext* cx, JS::HandleObject realm);
JSObject* InspectOptionsState(JSContext* cx, JS::HandleObject runtime);
bool ConfigureOptions(JSContext* cx, JS::HandleObject realm, JS::HandleObject arguments,
                      JS::HandleString environmentOptions);
void CaptureOptionsInvocation(int argc, char** argv, bool nodeMode);
}
#endif
