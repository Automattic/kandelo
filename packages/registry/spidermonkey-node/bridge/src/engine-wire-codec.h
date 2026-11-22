#ifndef KANDELO_NODE_ENGINE_WIRE_CODEC_H
#define KANDELO_NODE_ENGINE_WIRE_CODEC_H
// The byte protocol is the pinned V8 format. This component owns only native
// bytes; JavaScript graph identity, roots and host-object policy belong to the
// SpiderMonkey adapter and the original Node serializer/message owners.
// The result contract is shared with the live SpiderMonkey adapter.
#include "engine-maybe-api.h"
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <type_traits>
#include <utility>

namespace v8::internal {
namespace base {
using uc16 = char16_t;
template<class T> class Vector {
  T* data_ = nullptr;
  size_t length_ = 0;
 public:
  Vector() = default;
  Vector(T* data,size_t length):data_(data),length_(length){}
  T* begin()const{return data_;}
  size_t length()const{return length_;}
};
inline void Free(void* data){std::free(data);}
inline void* Realloc(void* data,size_t size){return std::realloc(data,size);}
}
enum class SerializationTag:uint8_t;
inline bool IsAligned(uintptr_t pointer,size_t alignment){
  return (pointer&(alignment-1))==0;
}
class WireAllocationDelegate {
 public:
  virtual ~WireAllocationDelegate()=default;
  virtual void* ReallocateBufferMemory(void*,size_t,size_t*)=0;
  virtual void FreeBufferMemory(void*)=0;
};
class ValueSerializer {
  WireAllocationDelegate* delegate_;
  uint8_t* buffer_=nullptr;
  size_t buffer_size_=0,buffer_capacity_=0;
  bool out_of_memory_=false;
  Maybe<uint8_t*> ReserveRawBytes(size_t);
  Maybe<bool> ExpandBuffer(size_t);
 public:
  explicit ValueSerializer(WireAllocationDelegate* delegate=nullptr):delegate_(delegate){}
  ~ValueSerializer();
  ValueSerializer(const ValueSerializer&)=delete;
  ValueSerializer& operator=(const ValueSerializer&)=delete;
  void WriteHeader();
  void WriteTag(SerializationTag);
  template<class T> void WriteVarint(T);
  template<class T> void WriteZigZag(T);
  void WriteDouble(double);
  void WriteOneByteString(base::Vector<const uint8_t>);
  void WriteTwoByteString(base::Vector<const base::uc16>);
  void WriteRawBytes(const void*,size_t);
  void WriteByte(uint8_t);
  void WriteUint32(uint32_t);
  void WriteUint64(uint64_t);
  void SetTreatArrayBufferViewsAsHostObjects(bool);
  bool treat_array_buffer_views_as_host_objects_=false;
  std::pair<uint8_t*,size_t> Release();
  bool Failed()const{return out_of_memory_;}
  size_t Size()const{return buffer_size_;}
  size_t Capacity()const{return buffer_capacity_;}
};
class ValueDeserializer {
  inline static constexpr uint8_t empty_data_[1]={0};
  const uint8_t* start_;
  const uint8_t* position_;
  const uint8_t* end_;
  uint32_t version_=0;
  void(*version_error_)(void*);
  void* version_error_data_;
  bool version_failed_=false;
  void ReportVersionError(){
    version_failed_=true;
    if(version_error_)version_error_(version_error_data_);
  }
 public:
  ValueDeserializer(const uint8_t* data,size_t length,
      void(*error)(void*)=nullptr,void* opaque=nullptr):
      start_(data?data:empty_data_),position_(start_),end_(start_+(data?length:0)),version_error_(error),version_error_data_(opaque){
    if(!data&&length)Crash("Nonempty wire input requires a buffer");
  }
  ValueDeserializer(const ValueDeserializer&)=delete;
  ValueDeserializer& operator=(const ValueDeserializer&)=delete;
  Maybe<bool> ReadHeader();
  uint32_t GetWireFormatVersion()const{return version_;}
  Maybe<SerializationTag> PeekTag()const;
  void ConsumeTag(SerializationTag);
  Maybe<SerializationTag> ReadTag();
  template<class T> Maybe<T> ReadVarint();
  template<class T> Maybe<T> ReadVarintLoop();
  template<class T> Maybe<T> ReadZigZag();
  Maybe<double> ReadDouble();
  Maybe<base::Vector<const uint8_t>> ReadRawBytes(size_t);
  Maybe<base::Vector<const base::uc16>> ReadRawTwoBytes(size_t);
  bool ReadByte(uint8_t*);
  bool ReadUint32(uint32_t*);
  bool ReadUint64(uint64_t*);
  bool ReadDouble(double*);
  bool ReadRawBytes(size_t,const void**);
  bool VersionFailed()const{return version_failed_;}
  size_t Remaining()const{return size_t(end_-position_);}
  size_t Position()const{return size_t(position_-start_);}
  void Rewind(size_t offset){if(offset>size_t(end_-start_))Crash("Invalid wire rewind");position_=start_+offset;}
};
}
#endif
