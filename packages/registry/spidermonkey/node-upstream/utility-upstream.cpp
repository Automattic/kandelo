// Every original utility body is compiled; no function/constructor is extracted.
#include "shell/node-upstream/codec-agent-includes.h"
#include "shell/node-upstream/codec-native-api.h"
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/utilities-upstream/node_union_bytes.h"
#undef node
#undef v8
#include "shell/node-upstream/utility-support-native-api.h"
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/utilities-upstream/util.cc"
