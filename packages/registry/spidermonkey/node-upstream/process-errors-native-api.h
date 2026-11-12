#ifndef KANDELO_NODE_PROCESS_ERRORS_NATIVE_API_H
#define KANDELO_NODE_PROCESS_ERRORS_NATIVE_API_H
#include "shell/node-upstream/process-files-native-api.h"
namespace kandelo_node_codec_impl {
Local<Value> ErrnoException(Isolate*,int,const char*,const char*,const char*);
Local<Value> UVException(Isolate*,int,const char*,const char*,const char*,const char*);
namespace errors {
// These belong to the complete original node_errors.cc unit. They remain
// unresolved when used until its genuine native prerequisites are integrated.
const char* errno_string(int);
void TriggerUncaughtException(Isolate*,const TryCatch&);
}
}
#endif
