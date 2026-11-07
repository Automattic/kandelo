// Test-only actual error adapter. Production uses the same captured native data
// and ApplyErrorProperties through rooted SpiderMonkey JSAPI operations.
#ifndef KANDELO_TEST_CRYPTO_ERROR_NAPI_H
#define KANDELO_TEST_CRYPTO_ERROR_NAPI_H
#include <node_api.h>
#include "../../crypto-errors.h"
#include <cstdlib>
namespace kandelo::crypto::test {
inline bool Set(napi_env env,napi_value object,const char* name,napi_value value) {
  const auto status=napi_set_named_property(env,object,name,value);
  if(status==napi_ok)return true;
  bool pending=false;napi_is_exception_pending(env,&pending);
  // N-API collapses a genuine nonthrowing V8 false result to generic_failure;
  // Node's Set(...).IsNothing()/Check() ignores that false value.
  return !pending && status==napi_generic_failure;
}
inline napi_value MakeError(napi_env env,const Error& error,
    std::optional<ErrorKind> requested=std::nullopt,bool checked=true) {
  bool pending=false;napi_is_exception_pending(env,&pending);if(pending)return nullptr;
  napi_value message,result;
  if(napi_create_string_utf8(env,error.message.data(),error.message.size(),&message)!=napi_ok)return nullptr;
  const auto kind=requested.value_or(error.checkedNodeCode?NativeNodeKind(error.code).value_or(ErrorKind::Error):ErrorKind::Error);
  napi_status created;
  if(kind==ErrorKind::TypeError)created=napi_create_type_error(env,nullptr,message,&result);
  else if(kind==ErrorKind::RangeError)created=napi_create_range_error(env,nullptr,message,&result);
  else created=napi_create_error(env,nullptr,message,&result);
  if(created!=napi_ok)return nullptr;
  const bool applied=ApplyErrorProperties(error,
    [&](const std::vector<std::string>& values){
      napi_value array;if(napi_create_array_with_length(env,values.size(),&array)!=napi_ok)return false;
      for(uint32_t i=0;i<values.size();++i){
        napi_value value;if(napi_create_string_utf8(env,values[i].data(),values[i].size(),&value)!=napi_ok)return false;
        const std::string name=std::to_string(i);
        napi_property_descriptor prop{name.c_str(),nullptr,nullptr,nullptr,nullptr,value,
          static_cast<napi_property_attributes>(napi_writable|napi_enumerable|napi_configurable),nullptr};
        if(napi_define_properties(env,array,1,&prop)!=napi_ok)return false;
      }
      return Set(env,result,"opensslErrorStack",array);
    },
    [&](const std::string& name,const std::string& value){
      napi_value field;if(napi_create_string_latin1(env,value.data(),value.size(),&field)!=napi_ok)return false;
      return Set(env,result,name.c_str(),field);
    });
  if(error.checkedNodeCode&&checked&&!applied)std::abort();
  return applied?result:nullptr;
}
} // namespace kandelo::crypto::test
#endif
