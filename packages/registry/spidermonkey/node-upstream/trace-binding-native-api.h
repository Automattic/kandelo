#ifndef KANDELO_NODE_TRACE_BINDING_NATIVE_API_H
#define KANDELO_NODE_TRACE_BINDING_NATIVE_API_H
#include "shell/node-upstream/codec-agent-includes.h"
#include "shell/node-upstream/codec-native-api.h"
namespace node {
using namespace kandelo_node_codec_impl;
using kandelo_node_codec_impl::Environment;
class ExternalReferenceRegistry : public kandelo_node_codec_impl::ExternalReferenceRegistry {};
bool AdmitTraceWrite(Environment*,const std::string&);
}
#define THROW_IF_INSUFFICIENT_PERMISSIONS(environment,scope,path) \
  do { if(!::node::AdmitTraceWrite(environment,path)) return; } while(false)
#endif
