#ifndef KANDELO_NODE_ENGINE_BUFFER_OWNER_INL_H
#define KANDELO_NODE_ENGINE_BUFFER_OWNER_INL_H

// Concrete byte-retention ownership lives in the bridge. Engine object slots
// hold the generic lease; native jobs can keep that same lease after detach,
// wrapper collection or realm disposal. No JS edge or State is captured here.
namespace v8::bridge {
class NativeBufferOwner final:public js::NativeArrayBufferOwner {
  js::ArrayBufferObject::BufferContents contents_;
  const size_t allocationLength_;
  std::atomic<size_t> byteLength_;
  const size_t maxByteLength_;
  const bool resizable_;
  bool committed_=false;
 public:
  NativeBufferOwner(js::ArrayBufferObject::BufferContents contents,
      size_t length,size_t maximum,bool resizable)
      :contents_(std::move(contents)),allocationLength_(maximum),
       byteLength_(length),maxByteLength_(maximum),resizable_(resizable){}
  ~NativeBufferOwner() override {
    if(committed_)js::ReleaseNativeArrayBufferContents(contents_,allocationLength_);
  }
  const js::ArrayBufferObject::BufferContents& contents()const override{return contents_;}
  size_t allocationLength()const override{return allocationLength_;}
  size_t byteLength()const override{return byteLength_.load(std::memory_order_relaxed);}
  size_t maxByteLength()const override{return maxByteLength_;}
  bool resizable()const override{return resizable_;}
  bool committed()const override{return committed_;}
  void commit()override{committed_=true;}
  void resize(size_t length)override{byteLength_.store(length,std::memory_order_relaxed);}
};
std::shared_ptr<js::NativeArrayBufferOwner> NewNativeBufferOwner(
    js::ArrayBufferObject::BufferContents contents,size_t length,size_t maximum,
    bool resizable){
  return std::make_shared<NativeBufferOwner>(std::move(contents),length,maximum,resizable);
}
void RegisterNativeBufferOwnerFactory(){
  js::SetNativeArrayBufferOwnerFactory(NewNativeBufferOwner);
}
}
#endif
