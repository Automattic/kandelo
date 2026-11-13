#include <libplatform/v8-tracing.h>
#include <uv.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <sstream>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

using v8::platform::tracing::TraceBuffer;
using v8::platform::tracing::TraceConfig;
using v8::platform::tracing::TraceObject;
using v8::platform::tracing::TraceWriter;
using v8::platform::tracing::TracingController;
// Primitive flag/type metadata from the pinned complete
// deps/v8/src/tracing/trace-event-no-perfetto.h, not tracing algorithms.
constexpr unsigned kCopy=1U<<0, kHasId=1U<<1;
constexpr uint8_t kInteger=3, kConvertable=8;
static int cases=0;
static void require(bool value,const char* reason) {
  if(!value){std::fprintf(stderr,"FAILED: %s\n",reason);std::exit(1);}
}
static void pass(const char* name) {
  ++cases;std::printf("{\"case\":\"%s\",\"status\":\"pass\"}\n",name);
}
struct Observer: v8::TracingController::TraceStateObserver {
  int enabled=0,disabled=0;
  void OnTraceEnabled() override {++enabled;}
  void OnTraceDisabled() override {++disabled;}
};
struct JsonValue: v8::ConvertableToTraceFormat {
  std::atomic<int>* released;
  explicit JsonValue(std::atomic<int>* count):released(count){}
  ~JsonValue() override {++*released;}
  void AppendAsTraceFormat(std::string* out) const override {
    *out+="{\"nested\":\"中\",\"number\":42}";
  }
};
struct Worker {
  TracingController* controller;const uint8_t* flag;
  std::atomic<int>* recorded;int tid=0;
};
static void recordWorker(void* opaque) {
  auto* worker=static_cast<Worker*>(opaque);worker->tid=gettid();
  for(int i=0;i<8;++i)
    if(worker->controller->AddTraceEvent('i',worker->flag,"worker","",0,0,
         0,nullptr,nullptr,nullptr,nullptr,kCopy)!=0) ++*worker->recorded;
}
int main() {
  std::ostringstream stream;std::atomic<int> released{0};
  {
    Observer observer;TracingController controller;
    TraceBuffer* buffer=TraceBuffer::CreateTraceBufferRingBuffer(2,
      TraceWriter::CreateJSONTraceWriter(stream));
    controller.Initialize(buffer);controller.AddTraceStateObserver(&observer);
    const uint8_t* group=controller.GetCategoryGroupEnabled("node.kandelo,other");
    require(*group==0&&controller.GetCategoryGroupEnabled("node.kandelo,other")==group,
      "disabled category must be a stable actual flag");
    require(std::strcmp(TracingController::GetCategoryGroupName(group),"node.kandelo,other")==0,
      "category pointer/name association");
    pass("disabled-category-real-state");
    auto* config=new TraceConfig;config->AddIncludedCategory("node.kandelo");
    controller.StartTracing(config);
    require(*group!=0&&*controller.GetCategoryGroupEnabled("not-enabled")==0&&observer.enabled==1,
      "actual category filtering and enable observer");
    pass("enabled-category-flags-and-observer");
    char name[]="copied-name";const char* arg_name="value";uint8_t type=kInteger;
    uint64_t arg=uint64_t(int64_t(-7));
    auto handle=controller.AddTraceEvent('B',group,name,"",17,0,1,&arg_name,&type,&arg,nullptr,kCopy|kHasId);
    name[0]='X';auto* event=buffer->GetEventByHandle(handle);
    require(event&&std::strcmp(event->name(),"copied-name")==0&&event->pid()==getpid()&&event->tid()==gettid(),
      "copied event name and actual guest process/thread identity");
    pass("copied-event-payload-and-native-identities");
    std::unique_ptr<v8::ConvertableToTraceFormat> json(new JsonValue(&released));
    type=kConvertable;arg_name="data";arg=0;
    handle=controller.AddTraceEvent('i',group,"json-data","",0,0,1,&arg_name,&type,&arg,&json,kCopy);
    require(handle!=0&&!json&&released.load()==0,"real convertable ownership transfer");
    pass("convertable-value-ownership");
    handle=controller.AddTraceEvent('X',group,"duration","",0,0,0,nullptr,nullptr,nullptr,nullptr,kCopy);
    uv_sleep(3);controller.UpdateTraceEventDuration(group,"duration",handle);
    event=buffer->GetEventByHandle(handle);
    require(event&&event->duration()>0&&event->ts()>0&&event->tts()>=0,"actual guest duration clocks");
    pass("actual-duration-clocks");
    std::atomic<int> recorded{0};Worker workers[2]={{&controller,group,&recorded},{&controller,group,&recorded}};
    uv_thread_t threads[2];
    for(int i=0;i<2;++i)require(uv_thread_create(&threads[i],recordWorker,&workers[i])==0,"thread creation");
    for(auto& thread:threads)require(uv_thread_join(&thread)==0,"thread completion");
    require(recorded.load()==16&&workers[0].tid!=workers[1].tid&&workers[0].tid!=gettid()&&workers[1].tid!=gettid(),
      "concurrent actual guest threads must record independently");
    pass("concurrent-guest-thread-recording");
    controller.StopTracing();
    require(*group==0&&observer.disabled==1,"stop updates actual retained category byte");
    require(controller.AddTraceEvent('i',group,"disabled","",0,0,0,nullptr,nullptr,nullptr,nullptr,kCopy)==0,
      "stopped controller must not record");
    config=new TraceConfig;config->AddIncludedCategory("node.kandelo");controller.StartTracing(config);
    require(*group!=0&&observer.enabled==2,"restart state");
    require(controller.AddTraceEvent('i',group,"restart","",0,0,0,nullptr,nullptr,nullptr,nullptr,kCopy)!=0,"restart event");
    controller.StopTracing();require(*group==0&&observer.disabled==2,"restart disable state");
    controller.RemoveTraceStateObserver(&observer);
    pass("stop-restart-flags-and-observers");
  }
  require(released.load()==1,"convertable destroyed exactly once");
  mkdir("/tmp",0777);const char* path="/tmp/v8-trace-controls.json";
  {std::ofstream output(path);output<<stream.str();require(output.good(),"guest file write");}
  std::ifstream input(path);std::string bytes((std::istreambuf_iterator<char>(input)),{});
  require(bytes==stream.str()&&bytes.find("copied-name")!=std::string::npos&&bytes.find("Xopied-name")==std::string::npos,
    "original JSON writer and real guest file round trip");
  ++cases;std::printf("{\"case\":\"original-json-writer-and-guest-file\",\"status\":\"pass\",\"trace\":%s}\n",bytes.c_str());
  std::ostringstream wrapped;
  {
    TracingController controller;
    TraceBuffer* buffer=TraceBuffer::CreateTraceBufferRingBuffer(1,TraceWriter::CreateJSONTraceWriter(wrapped));
    controller.Initialize(buffer);auto* config=new TraceConfig;config->AddIncludedCategory("ring");controller.StartTracing(config);
    auto* flag=controller.GetCategoryGroupEnabled("ring");uint64_t first=0;
    for(size_t i=0;i<v8::platform::tracing::TraceBufferChunk::kChunkSize+1;++i){auto handle=controller.AddTraceEvent('i',flag,"wrap","",0,0,0,nullptr,nullptr,nullptr,nullptr,kCopy);require(handle!=0,"ring recording");if(i==0)first=handle;}
    require(buffer->GetEventByHandle(first)==nullptr,"overwritten native handle must retire");controller.StopTracing();
  }
  ++cases;std::printf("{\"case\":\"ring-buffer-handle-retirement\",\"status\":\"pass\",\"trace\":%s}\n",wrapped.str().c_str());
  std::printf("{\"kind\":\"v8-tracing-component-controls\",\"cases\":%d,\"failures\":0}\n",cases);
}
