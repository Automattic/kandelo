#ifndef KANDELO_ENGINE_PROFILER_STREAM_SUPPORT_H
#define KANDELO_ENGINE_PROFILER_STREAM_SUPPORT_H
#include <climits>
#include <cstring>
#include <memory>
namespace v8::internal {
inline constexpr int kMaxInt=INT_MAX;
inline void MemCopy(void* out,const void* input,size_t bytes){std::memcpy(out,input,bytes);}
class NativeProfileChunk {
  std::unique_ptr<char[]> bytes_;
  const int size_;
 public:
  explicit NativeProfileChunk(int size):size_(size){CHECK_GT(size,0);bytes_=std::make_unique<char[]>(size_t(size));}
  char* begin(){return bytes_.get();}
  char* end(){return bytes_.get()+size_;}
  char& operator[](int index){return bytes_[size_t(index)];}
};
}
#endif
