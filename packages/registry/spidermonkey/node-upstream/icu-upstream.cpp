// Execute the complete original native ICU source against the engine API.
#include "shell/node-upstream/codec-native-api.h"
#define NODE_HAVE_I18N_SUPPORT 1
#undef NODE_BINDING_CONTEXT_AWARE_INTERNAL
#define NODE_BINDING_CONTEXT_AWARE_INTERNAL(name,callback) namespace kandelo_icu_adapter { ContextInitializer context_initializer=::callback; }
#define NODE_BINDING_PER_ISOLATE_INIT(name,callback) namespace kandelo_icu_adapter { PerIsolateInitializer initializer=::callback; }
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/node_i18n.cc"
