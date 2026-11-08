// Exact generated real codec contexts; NAPI/Node C codec symbols are fixture dependencies.
#include <node_api.h>
#include <exception>
#include <sstream>
#include <stdexcept>
#include <thread>
#include "native-codec-contexts.h"
namespace codec = kandelo::codecs;
static void Check(bool value, const char* why) { if (!value) throw std::runtime_error(why); }
static std::string Quote(const std::string& value) {
  std::string out="\"";for(unsigned char c:value){if(c=='\\'||c=='\"')out+='\\';if(c=='\n')out+="\\n";else out+=c;}return out+'\"';
}
template<class Context> struct Owner {
  codec::CompressionStreamMemoryOwner memory;
  std::unique_ptr<Context> context=std::make_unique<Context>();
  Owner() { context->SetAllocator(&memory); }
  ~Owner() { context->Close();context.reset();if(memory.LiveCodecBytes()!=0)std::abort(); }
  size_t Native() const { return context->RetainedNativeBytes(); }
  size_t Total() const { return codec::capacity::Add(Native(),memory.LiveCodecBytes()); }
};
static std::vector<uint8_t> Dictionary(size_t reserve=4096) {
  std::vector<uint8_t> data;data.reserve(reserve);data.assign({'d','i','c','t'});return data;
}
static void Work(codec::CodecContext& context,const char* data,size_t size,int flush,bool thread=false) {
  char output[4096]{};context.SetBuffers(data,static_cast<uint32_t>(size),output,sizeof(output));context.SetFlush(flush);
  std::exception_ptr failure;
  if(thread){std::thread worker([&]{try{context.DoThreadPoolWork();}catch(...){failure=std::current_exception();}});worker.join();if(failure)std::rethrow_exception(failure);}
  else context.DoThreadPoolWork();
  context.SetBuffers(nullptr,0,nullptr,0);
}
static napi_value Exercise(napi_env env,napi_callback_info) {
  std::ostringstream report;report<<"{\"rows\":[";unsigned groups=0,failures=0;
  auto group=[&](const char* name,auto fn){if(groups++)report<<',';report<<"{\"name\":"<<Quote(name);try{const auto detail=fn();report<<",\"detail\":"<<detail<<",\"pass\":true}";}catch(const std::exception& error){++failures;report<<",\"error\":"<<Quote(error.what())<<",\"pass\":false}";}};
  group("empty-sso-heap-retained-clear",[]{
    std::string empty,shortString="short";Check(codec::capacity::StringBytes(empty)==0,"empty string double counted");Check(codec::capacity::StringBytes(shortString)==0,"SSO double counted");
    std::string heap;heap.reserve(8192);heap="x";const auto bytes=codec::capacity::StringBytes(heap);Check(bytes>=8193,"heap capacity not requested storage");heap.clear();Check(codec::capacity::StringBytes(heap)==bytes,"clear lost retained heap capacity");
    std::vector<uint64_t> vector;vector.reserve(256);vector.resize(1);const auto storage=codec::capacity::VectorBytes(vector);Check(storage>=2048,"vector reports logical length");vector.clear();Check(codec::capacity::VectorBytes(vector)==storage,"vector clear lost capacity");return "{\"heap\":"+std::to_string(bytes)+",\"vector\":"+std::to_string(storage)+"}";
  });
  group("zlib-dictionary-capacity-reset-close",[]{
    Owner<codec::ZlibContext> owner;auto& c=*owner.context;c.SetMode(codec::DEFLATE);Check(owner.Native()==sizeof(c),"initial zlib self allocation");auto dict=Dictionary();const auto cap=dict.capacity();c.Init(-1,15,8,Z_DEFAULT_STRATEGY,false,std::move(dict));Check(owner.Native()==sizeof(c)+cap,"moved zlib dictionary capacity");
    Work(c,"dict and more data",18,Z_FINISH);Check(!c.GetErrorInfo().IsError(),"real zlib compression failed");Check(owner.memory.LiveCodecBytes()>0,"actual zlib allocations absent");auto total=owner.Total();Check(total>owner.Native(),"custom blocks omitted");c.ResetStream();Check(owner.Native()==sizeof(c)+cap,"zlib reset discarded retained dictionary");c.Close();Check(owner.memory.LiveCodecBytes()==0,"zlib close did not free codec blocks");Check(owner.Native()==sizeof(c)+cap,"close discarded still-owned vector capacity");return "{\"dictionaryCapacity\":"+std::to_string(cap)+",\"totalDuringWork\":"+std::to_string(total)+"}";
  });
  group("brotli-encoder-params-reset-close",[]{
    Owner<codec::BrotliEncoderContext> owner;auto& c=*owner.context;c.SetMode(codec::BROTLI_ENCODE);Check(owner.Native()==sizeof(c),"initial brotli encoder self allocation");auto dict=Dictionary();auto cap=dict.capacity();Check(!c.Init(std::move(dict)).IsError(),"real brotli encoder init failed");Check(owner.Native()==sizeof(c)+cap,"brotli moved dictionary capacity");
    Check(!c.SetParams(BROTLI_PARAM_QUALITY,5).IsError(),"real brotli parameter failed");auto params=owner.Native();Check(params>sizeof(c)+cap,"params capacity missing");Check(!c.SetParams(BROTLI_PARAM_QUALITY,6).IsError(),"repeated real parameter failed");Check(owner.Native()==params,"parameter replacement changed retained capacity");
    Work(c,"dict and more data",18,BROTLI_OPERATION_FINISH);Check(!c.GetErrorInfo().IsError(),"real brotli compression failed");Check(!c.ResetStream().IsError(),"brotli reset failed");auto reset=owner.Native();Check(reset>=sizeof(c)+4,"reset retained storage absent");c.Close();Check(owner.memory.LiveCodecBytes()==0,"brotli close library allocation leak");Check(owner.Native()==reset,"close did not retain actual vectors");return "{\"initialDictionaryCapacity\":"+std::to_string(cap)+",\"afterParams\":"+std::to_string(params)+",\"afterReset\":"+std::to_string(reset)+"}";
  });
  group("brotli-decoder-worker-error-storage",[]{
    Owner<codec::BrotliDecoderContext> owner;auto& c=*owner.context;c.SetMode(codec::BROTLI_DECODE);Check(!c.Init().IsError(),"brotli decode init failed");auto initial=owner.Native();Check(initial==sizeof(c),"initial decoder SSO counted twice");const char corrupt[]={char(0xff),char(0xff),char(0xff)};Work(c,corrupt,sizeof(corrupt),BROTLI_OPERATION_FINISH,true);Check(c.GetErrorInfo().IsError(),"corrupt brotli unexpectedly accepted");auto failed=owner.Native();Check(failed>initial,"real worker error string heap unaccounted");c.Close();Check(owner.memory.LiveCodecBytes()==0,"decoder library allocations leaked");Check(owner.Native()==failed,"close lost retained worker error string");return "{\"before\":"+std::to_string(initial)+",\"afterWorkerError\":"+std::to_string(failed)+"}";
  });
  group("brotli-parameter-initialization-failure-cleanup",[]{
    Owner<codec::BrotliEncoderContext> owner;auto& c=*owner.context;c.SetMode(codec::BROTLI_ENCODE);auto dict=Dictionary(8192);auto cap=dict.capacity();Check(!c.Init(std::move(dict)).IsError(),"partial initialization prerequisite failed");auto before=owner.Native();Check(c.SetParams(-1,0).IsError(),"invalid real codec parameter accepted");Check(owner.Native()==before,"failed parameter fabricated vector entry");c.Close();Check(owner.memory.LiveCodecBytes()==0,"partial-init library allocations leaked");Check(owner.Native()==sizeof(c)+cap,"partial init close lost retained dictionary capacity");return "{\"retainedAfterFailure\":"+std::to_string(owner.Native())+"}";
  });
  group("zstd-compressor-self-and-library-ledger",[]{
    Owner<codec::ZstdCompressContext> owner;auto& c=*owner.context;Check(owner.Native()==sizeof(c),"initial zstd SSO counted twice");Check(!c.Init(ZSTD_CONTENTSIZE_UNKNOWN).IsError(),"actual zstd init failed");Check(!c.SetParameter(ZSTD_c_compressionLevel,2).IsError(),"actual zstd param failed");Work(c,"source",6,ZSTD_e_end,true);Check(!c.GetErrorInfo().IsError(),"real zstd compression failed");auto total=owner.Total();Check(total>owner.Native(),"actual zstd allocator blocks missing");c.Close();Check(owner.memory.LiveCodecBytes()==0,"zstd close library allocation leak");Check(owner.Native()==sizeof(c),"empty zstd strings double counted");return "{\"self\":"+std::to_string(owner.Native())+",\"total\":"+std::to_string(total)+"}";
  });
  group("zstd-decoder-worker-error-clear-reset-close",[]{
    Owner<codec::ZstdDecompressContext> owner;auto& c=*owner.context;Check(!c.Init(ZSTD_CONTENTSIZE_UNKNOWN).IsError(),"real zstd decoder init failed");auto initial=owner.Native();const char corrupt[]={0,0,0,0,0};Work(c,corrupt,sizeof(corrupt),ZSTD_e_end,true);Check(c.GetErrorInfo().IsError(),"corrupt zstd unexpectedly accepted");auto error=owner.Native();Check(error>initial,"worker zstd string capacity missing");Check(!c.ResetStream().IsError(),"actual decoder reset failed");Check(owner.Native()==error,"clear/reset lost retained string capacity");c.Close();Check(owner.memory.LiveCodecBytes()==0,"zstd decode allocator leak");Check(owner.Native()==error,"close lost retained string allocations");return "{\"before\":"+std::to_string(initial)+",\"errorAndReset\":"+std::to_string(error)+"}";
  });
  report<<"],\"groups\":"<<groups<<",\"failures\":"<<failures<<'}';auto text=report.str();napi_value result;napi_create_string_utf8(env,text.data(),text.size(),&result);return result;
}
static napi_value Initialize(napi_env env,napi_value exports) {napi_property_descriptor method={"exercise",nullptr,Exercise,nullptr,nullptr,nullptr,napi_default,nullptr};napi_define_properties(env,exports,1,&method);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Initialize)
