// Compile the complete original native unit; embedding interfaces are separate.
#include "shell/node-upstream/codec-agent-includes.h"
#include "shell/node-upstream/codec-native-api.h"
#include "shell/node-upstream/codecs-upstream/ada.h"
#include "shell/node-upstream/process-files-native-api.h"
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/path.cc"
