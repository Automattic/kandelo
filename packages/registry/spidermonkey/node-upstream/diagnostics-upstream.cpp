// Compile the complete pinned diagnostics unit. Native algorithms stay intact.
#include "shell/node-upstream/codec-agent-includes.h"
#include "shell/node-upstream/codec-native-api.h"
namespace kandelo_node_codec_impl { using ::node::arraysize; }
#undef NODE_BINDING_CONTEXT_AWARE_INTERNAL
#define NODE_BINDING_CONTEXT_AWARE_INTERNAL(name,callback) namespace kandelo_diagnostics_adapter { Initializer initializer=::callback; }
#define NODE_BINDING_PER_ISOLATE_INIT(name,callback) namespace kandelo_diagnostics_adapter { IsolateInitializer isolate_initializer=::callback; }
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/aliased_buffer-inl.h"
#include "shell/node-upstream/codecs-upstream/node_diagnostics_channel.cc"

// Existing wrappers now acquire the canonical native reference cell. They
// must never accept an independently deleting std::shared_ptr owner.
static_assert(std::is_constructible_v<kandelo_node_codec_impl::BaseObjectPtr<kandelo_node_codec_impl::diagnostics_channel::Channel>,kandelo_node_codec_impl::diagnostics_channel::Channel*>);
static_assert(!std::is_constructible_v<kandelo_node_codec_impl::BaseObjectPtr<kandelo_node_codec_impl::diagnostics_channel::Channel>,std::shared_ptr<kandelo_node_codec_impl::diagnostics_channel::Channel>>);
static_assert(std::is_copy_constructible_v<kandelo_node_codec_impl::BaseObjectPtr<kandelo_node_codec_impl::diagnostics_channel::Channel>>);
