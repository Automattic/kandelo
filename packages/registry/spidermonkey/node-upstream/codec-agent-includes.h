#ifndef KANDELO_CODEC_AGENT_INCLUDES_H
#define KANDELO_CODEC_AGENT_INCLUDES_H
// Load the real controller and Node agent declarations before the private
// JS-handle API and before any namespace alias used by whole source includes.
#include "shell/node-upstream/codec-buffer-types.h"
#include "shell/node-upstream/trace-agent-native-api.h"
#include "shell/node-upstream/tracing-upstream/tracing/agent.h"
#include "shell/node-upstream/tracing-upstream/tracing/trace_event_helper.h"
#include "shell/node-upstream/tracing-upstream/tracing/trace_event_legacy_inl.h"
#endif
