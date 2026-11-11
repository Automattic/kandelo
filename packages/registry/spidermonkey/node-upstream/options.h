#ifndef KANDELO_NODE_OPTIONS_H
#define KANDELO_NODE_OPTIONS_H
#include "js/TypeDecls.h"
namespace kandelo::node {
JSObject* CreateOptionsState(JSContext* cx);
bool InitializeOptionsForRealm(JSContext* cx, JS::HandleObject realm);
JSObject* CreateOptionsBinding(JSContext* cx, JS::HandleObject realm);
JSObject* InspectOptionsState(JSContext* cx, JS::HandleObject runtime);
bool ConfigureOptions(JSContext* cx, JS::HandleObject realm, JS::HandleObject arguments,
                      JS::HandleString environmentOptions);
void CaptureOptionsInvocation(int argc, char** argv, bool nodeMode);
}
#endif
