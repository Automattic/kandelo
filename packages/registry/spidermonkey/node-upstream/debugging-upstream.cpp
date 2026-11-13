// Compile the complete original diagnostics unit, including platform branches.
#include "shell/node-upstream/codec-agent-includes.h"
#include "shell/node-upstream/codec-native-api.h"
#include "shell/node-upstream/debugging-native-api.h"
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/debugging-upstream/debug_utils.cc"
