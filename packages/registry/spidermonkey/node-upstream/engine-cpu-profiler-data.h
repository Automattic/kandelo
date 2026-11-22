#ifndef KANDELO_ENGINE_CPU_PROFILER_DATA_H
#define KANDELO_ENGINE_CPU_PROFILER_DATA_H
#include <atomic>
#include <chrono>
#include <climits>
#include <condition_variable>
#include <map>
#include <mutex>
#include <thread>
#include <system_error>
#include <tuple>
#include "js/GCVector.h"
#include "engine-native-api.h"

namespace v8::internal {
class CpuProfiler;
class OutputStreamWriter;
struct NativeCpuSampling;
struct NativeProfileTime {
  int64_t value;
  NativeProfileTime since_origin()const{return *this;}
  NativeProfileTime operator-(NativeProfileTime other)const{return {value-other.value};}
  int64_t InMicroseconds()const{return value;}
};
struct NativeCpuFrame {
  std::string name,url;
  int scriptId=0,line=0,column=0,hitLine=0,hitColumn=0;
  v8::CpuProfileNode::SourceType source=v8::CpuProfileNode::kScript;
  size_t globalIndex=0;  // Index in the capture's rooted realm inventory.
};
// Native code metadata; tree construction, caller positions, tick aggregation
// and destruction remain the complete portable upstream ProfileNode/ProfileTree.
struct LineAndColumn {int line=0,column=0;};
class ProfileNode;
class ProfileTree;
class CodeEntry {
 public:
  using Key=std::tuple<int,std::string,int,int>;
  NativeCpuFrame frame;
  std::optional<v8::CpuProfileDeoptInfo> deopt;
  explicit CodeEntry(NativeCpuFrame value):frame(std::move(value)){}
  Key key()const{return {frame.scriptId,frame.name,frame.line,frame.column};}
  bool IsSameFunctionAs(const CodeEntry* other)const{
    return frame.scriptId==other->frame.scriptId&&frame.name==other->frame.name&&
        frame.line==other->frame.line&&frame.column==other->frame.column;
  }
  size_t GetHash()const{return std::hash<std::string>{}(frame.name)^std::hash<int>{}(frame.scriptId)^std::hash<int>{}(frame.line)^std::hash<int>{}(frame.column);}
  LineAndColumn line_and_column()const{return {frame.line,frame.column};}
  const char* name()const{return frame.name.c_str();}
  const char* resource_name()const{return frame.url.c_str();}
  int script_id()const{return frame.scriptId;}
  bool has_deopt_info()const{return deopt.has_value();}
  v8::CpuProfileDeoptInfo GetDeoptInfo()const{CHECK(deopt);return *deopt;}
  void clear_deopt_info(){deopt.reset();}
  static CodeEntry* root_entry(){
    static CodeEntry root([]{NativeCpuFrame frame;frame.name="(root)";frame.source=v8::CpuProfileNode::kInternal;return frame;}());
    return &root;
  }
};
namespace base {
class Hasher {
  size_t hash_;
 public:
  explicit Hasher(size_t value):hash_(value){}
  void Add(int value){hash_^=std::hash<int>{}(value)+size_t(0x9e3779b9)+(hash_<<6)+(hash_>>2);}
  size_t hash()const{return hash_;}
};
template<class T>struct hash:std::hash<T>{};
template<>struct hash<std::pair<int,int>> {
  size_t operator()(const std::pair<int,int>& value)const{Hasher hash(std::hash<int>{}(value.first));hash.Add(value.second);return hash.hash();}
};
template<class T>struct NativeReverseRange {
  const T& values;
  auto begin()const{return values.rbegin();}auto end()const{return values.rend();}
};
template<class T>NativeReverseRange<T> Reversed(const T& value){return {value};}
}
struct NativeCpuSample {ProfileNode* node;NativeProfileTime timestamp;};
class CpuProfile {
  CpuProfiler* owner_;
  v8::CpuProfilingOptions options_;
  std::unique_ptr<v8::DiscardedSamplesDelegate> delegate_;
  bool notified_=false;
  const bool filtered_;
 public:
  const v8::ProfilerId identity;
  std::string title;
  std::map<CodeEntry::Key,std::unique_ptr<CodeEntry>> entries_;
  std::unique_ptr<ProfileTree> tree_;
  std::vector<NativeCpuSample> samples;
  NativeProfileTime started,finished{0};
  bool active=true,recordSamples=true;
  int64_t lastSample=0;
  CpuProfile(CpuProfiler*,v8::ProfilerId,v8::CpuProfilingOptions,
      std::unique_ptr<v8::DiscardedSamplesDelegate>,std::string,bool);
  CpuProfiler* cpu_profiler()const{return owner_;}
  void Detach();
  void AddSample(const std::vector<NativeCpuFrame>&,const JS::RootedObjectVector&,int64_t,int);
  int samples_count()const{CHECK_LE(samples.size(),size_t(INT_MAX));return int(samples.size());}
  NativeProfileTime start_time()const{return started;}
  NativeProfileTime end_time()const{return finished;}
  const NativeCpuSample& sample(int i)const{return samples.at(size_t(i));}
  ProfileTree* top_down(){return tree_.get();}
  void Serialize(v8::OutputStream*);
};
class CpuProfiler {
  std::shared_ptr<NativeCpuSampling> sampling_;
 public:
  v8::Isolate* isolate;
  std::weak_ptr<v8::State> state;
  v8::CpuProfilingNamingMode naming;
  int interval=1000;
  bool registered=false;
  std::map<v8::ProfilerId,std::shared_ptr<CpuProfile>> profiles;
  CpuProfiler(v8::Isolate*,v8::CpuProfilingNamingMode);
  ~CpuProfiler();
  void Retire();
  void Capture();
  void StartSampler();
  void StopSampler();
  void DeleteProfile(CpuProfile*);
  v8::CpuProfilingResult Start(v8::CpuProfilingOptions,
      std::unique_ptr<v8::DiscardedSamplesDelegate>,std::string={},bool=true);
  v8::CpuProfile* Stop(v8::ProfilerId);
};
}
#endif
