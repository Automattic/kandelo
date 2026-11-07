// Real portable RSA owner over the native reference's identified ncrypto and
// OpenSSL artifact. N-API acquisition is an explicit non-production boundary.
#include "../../rsa-operations.h"
#include "../crypto-errors/napi-error.h"
#include <node_api.h>
#include <cstring>
#include <stdexcept>
using namespace kandelo::crypto;
struct Pending {};
static void Check(napi_status status){if(status!=napi_ok)throw Pending{};}
static bool Undefined(napi_env env,napi_value value){napi_valuetype type;Check(napi_typeof(env,value,&type));return type==napi_undefined||type==napi_null;}
struct Span {const unsigned char* data;size_t length;};
static Span View(napi_env env,napi_value value){bool yes;Check(napi_is_typedarray(env,value,&yes));void* data;size_t length;
 if(yes){napi_typedarray_type type;napi_value backing;size_t offset;Check(napi_get_typedarray_info(env,value,&type,&length,&data,&backing,&offset));size_t width=1;switch(type){case napi_int16_array:case napi_uint16_array:case napi_float16_array:width=2;break;case napi_int32_array:case napi_uint32_array:case napi_float32_array:width=4;break;case napi_float64_array:case napi_bigint64_array:case napi_biguint64_array:width=8;break;default:break;}return {static_cast<unsigned char*>(data),length*width};}
 Check(napi_is_dataview(env,value,&yes));if(yes){napi_value backing;size_t offset;Check(napi_get_dataview_info(env,value,&length,&data,&backing,&offset));return{static_cast<unsigned char*>(data),length};}
 Check(napi_get_arraybuffer_info(env,value,&data,&length));return{static_cast<unsigned char*>(data),length};}
static Bytes Copy(Span source){Bytes bytes;bytes.value.resize(source.length);for(size_t i=0;i<source.length;i++)bytes.value[i]=__atomic_load_n(source.data+i,__ATOMIC_RELAXED);return bytes;}
static std::string Text(napi_env env,napi_value value){size_t size;Check(napi_get_value_string_utf8(env,value,nullptr,0,&size));std::string text(size+1,'\0');Check(napi_get_value_string_utf8(env,value,text.data(),text.size(),&size));text.resize(size);return text;}
static bool IsString(napi_env env,napi_value value){napi_valuetype type;Check(napi_typeof(env,value,&type));return type==napi_string;}
static napi_value Operation(napi_env env,napi_callback_info info){napi_value result=nullptr,error=nullptr;Check(napi_get_undefined(env,&result));Check(napi_get_undefined(env,&error));
 try{ncrypto::MarkPopErrorOnReturn mark;size_t count=11;napi_value args[11];Check(napi_get_cb_info(env,info,&count,args,nullptr,nullptr));if(count!=11)throw std::runtime_error("Expected complete RSA arguments");int32_t number,format=1,type=1;Check(napi_get_value_int32(env,args[0],&number));if(!Undefined(env,args[2]))Check(napi_get_value_int32(env,args[2],&format));if(!Undefined(env,args[3]))Check(napi_get_value_int32(env,args[3],&type));
 auto keyBytes=Copy(View(env,args[1]));const bool hasPassword=!Undefined(env,args[4]);Bytes password=hasPassword?Copy(View(env,args[4])):Bytes{};
 auto key=KeyMaterial::Parse(false,keyBytes,KeyMaterial::Configuration(format,type,hasPassword?&password:nullptr));
 auto input=View(env,args[6]);if(input.length>INT_MAX)throw KeyError("buffer is too long","ERR_OUT_OF_RANGE");
 napi_value paddingValue;Check(napi_coerce_to_number(env,args[7],&paddingValue));uint32_t padding;Check(napi_get_value_uint32(env,paddingValue,&padding));const auto operation=RsaOperation(number);
 RsaImplicitRejection(key->asymmetric,operation,padding);
 std::string hash,mgf;if(IsString(env,args[8]))hash=Text(env,args[8]);auto digest=RsaDigest(IsString(env,args[8])?hash.c_str():nullptr);
 Span label{nullptr,0};if(!Undefined(env,args[9]))label=View(env,args[9]);if(label.length>INT_MAX)throw KeyError("oaepLabel is too big","ERR_OUT_OF_RANGE");
 if(IsString(env,args[10]))mgf=Text(env,args[10]);auto mgf1=RsaDigest(IsString(env,args[10])?mgf.c_str():nullptr);
 auto bytes=Copy(input),labelBytes=Copy(label);const unsigned char empty=0;
 auto output=RsaTransform(key->asymmetric,operation,padding,digest,mgf1,{labelBytes.value.empty()?&empty:labelBytes.value.data(),labelBytes.value.size()},{bytes.value.empty()?&empty:bytes.value.data(),bytes.value.size()});
 Check(napi_create_buffer_copy(env,output.size(),output.get(),nullptr,&result));
 }catch(const Error& failure){error=kandelo::crypto::test::MakeError(env,failure);if(!error)return nullptr;}
 catch(const Pending&){return nullptr;}catch(const std::exception& failure){napi_throw_error(env,nullptr,failure.what());return nullptr;}
 napi_value packet;Check(napi_create_object(env,&packet));Check(napi_set_named_property(env,packet,"value",result));Check(napi_set_named_property(env,packet,"error",error));return packet;}
static napi_value Init(napi_env env,napi_value exports){napi_value fn;Check(napi_create_function(env,"operation",NAPI_AUTO_LENGTH,Operation,nullptr,&fn));Check(napi_set_named_property(env,exports,"operation",fn));return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
