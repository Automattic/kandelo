// Whole original error unit; the errno mapping is not extracted or rewritten.
#include "shell/node-upstream/codec-agent-includes.h"
#include "shell/node-upstream/codec-native-api.h"
#include "shell/node-upstream/fatal-errors-native-api.h"
namespace kandelo_fatal_errors_adapter {using Initializer=kandelo_codec_adapter::Initializer;}
#undef NODE_BINDING_CONTEXT_AWARE_INTERNAL
#define NODE_BINDING_CONTEXT_AWARE_INTERNAL(name,callback) namespace kandelo_fatal_errors_adapter {Initializer initializer=::callback;}
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#define cli_options fatal_cli_options
#include "shell/node-upstream/codecs-upstream/node_errors.cc"
