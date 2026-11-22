// Native storage/checks for the complete upstream portable metadata header.
// The signature builders and type/flag algorithms remain in that header.
// This unit contains no V8 heap, compiler, machine-code or callback invoker.
#include "shell/node-upstream/engine-native-api.h"
#include "shell/node-upstream/engine-checks.h"

namespace v8 {
CFunction::CFunction(const void* address,const CFunctionInfo* info)
    :address_(address),type_info_(info){
  CHECK(address_&&type_info_);
}
CFunctionInfo::CFunctionInfo(const CTypeInfo& result,unsigned int count,
    const CTypeInfo* arguments,Int64Representation representation)
    :return_info_(result),repr_(representation),arg_count_(count),arg_info_(arguments){
  CHECK(repr_==Int64Representation::kNumber||repr_==Int64Representation::kBigInt);
  CHECK(!arg_count_||arg_info_);
  for(unsigned int i=0;i+1<arg_count_;++i)
    CHECK(arg_info_[i].GetType()!=CTypeInfo::kCallbackOptionsType);
}
const CTypeInfo& CFunctionInfo::ArgumentInfo(unsigned int index)const{
  CHECK_LT(index,ArgumentCount());return arg_info_[index];
}
}
