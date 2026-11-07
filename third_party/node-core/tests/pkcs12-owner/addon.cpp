// Actual production PKCS12 parser over pinned native Node/OpenSSL symbols.
// DER/PEM transport is an explicit component boundary, not production handoff.
#include <node_api.h>
#include "../crypto-errors/napi-error.h"
#include "x509-operations.h"
#include <cstring>
#include <openssl/pem.h>
#include <stdexcept>
static void Check(napi_status status){if(status!=napi_ok)throw std::runtime_error("PKCS12 NAPI conversion");}

static void Set(napi_env e,napi_value v,const char* key,napi_value value){Check(napi_set_named_property(e,v,key,value));}
static napi_value Bytes(napi_env e,const void* data,size_t length){napi_value v;void* copied;Check(napi_create_buffer_copy(e,length,data,&copied,&v));return v;}
static void Span(napi_env e,napi_value v,void**data,size_t*length){bool is;Check(napi_is_dataview(e,v,&is));if(is){napi_value buffer;size_t offset;Check(napi_get_dataview_info(e,v,length,data,&buffer,&offset));return;}Check(napi_is_typedarray(e,v,&is));if(is){napi_typedarray_type type;napi_value buffer;size_t offset,count;Check(napi_get_typedarray_info(e,v,&type,&count,data,&buffer,&offset));const size_t width=type<=napi_uint8_clamped_array?1:type<=napi_uint16_array?2:type<=napi_float32_array?4:8;*length=count*width;return;}Check(napi_is_arraybuffer(e,v,&is));if(is){Check(napi_get_arraybuffer_info(e,v,data,length));return;}throw kandelo::crypto::X509Error("PKCS12 component requires actual buffer storage","ERR_INVALID_ARG_TYPE");}
static napi_value Encoded(napi_env e,ncrypto::BIOPointer bio){if(!bio)throw std::runtime_error("PKCS12 component encoding");BUF_MEM* memory=bio;if(!memory)throw std::runtime_error("PKCS12 component BIO");return Bytes(e,memory->data,memory->length);}
static napi_value Error(napi_env e,const kandelo::crypto::Error& error){return kandelo::crypto::test::MakeError(e,error);}

static napi_value Parse(napi_env e,napi_callback_info info){size_t n=2;napi_value args[2],value,error;Check(napi_get_cb_info(e,info,&n,args,nullptr,nullptr));Check(napi_get_undefined(e,&value));Check(napi_get_undefined(e,&error));try{
 void* data;size_t length;Span(e,args[0],&data,&length);auto bio=kandelo::crypto::LoadPKCS12BIO(static_cast<unsigned char*>(data),length);
 if(!bio)throw kandelo::crypto::X509Error("Unable to read PKCS#12 data","ERR_CRYPTO_OPERATION_FAILED");
 napi_valuetype kind;Check(napi_typeof(e,args[1],&kind));std::string password;const char* pass=nullptr;
 if(kind!=napi_undefined){Span(e,args[1],&data,&length);password.assign(length?static_cast<const char*>(data):"",length);if(password.find('\0')!=std::string::npos)throw kandelo::crypto::X509Error("passphrase must not contain null bytes","ERR_INVALID_ARG_VALUE");pass=password.c_str();}
 auto parsed=kandelo::crypto::ParseCryptoPKCS12(bio,pass);Check(napi_create_object(e,&value));napi_value key,cert,additional;Check(napi_get_null(e,&key));Check(napi_get_null(e,&cert));
 if(parsed.key){auto out=ncrypto::BIOPointer::NewMem();if(!out||PEM_write_bio_PrivateKey(out.get(),parsed.key.get(),nullptr,nullptr,0,nullptr,nullptr)!=1)throw std::runtime_error("PKCS12 component key export");key=Encoded(e,std::move(out));}
 if(parsed.cert)cert=Encoded(e,parsed.cert.view().toDER());
 const int count=parsed.ca?sk_X509_num(parsed.ca.get()):0;Check(napi_create_array_with_length(e,0,&additional));uint32_t index=0;for(int i=0;i<count;i++){X509* ca=sk_X509_value(parsed.ca.get(),i);if(ca)Check(napi_set_element(e,additional,index++,Encoded(e,ncrypto::X509View(ca).toDER())));}
 Set(e,value,"privateKey",key);Set(e,value,"certificate",cert);Set(e,value,"additionalCertificates",additional);
 }catch(const kandelo::crypto::Error& failure){error=Error(e,failure);if(!error)return nullptr;}catch(const std::exception& failure){napi_throw_error(e,nullptr,failure.what());return nullptr;}
 napi_value packet;Check(napi_create_object(e,&packet));Set(e,packet,"value",value);Set(e,packet,"error",error);return packet;}
// Genuine serialized OpenSSL bundles for empty/key-only/password controls.
static napi_value Variant(napi_env e,napi_callback_info info){try{size_t n=4;napi_value args[4];Check(napi_get_cb_info(e,info,&n,args,nullptr,nullptr));int32_t mode;Check(napi_get_value_int32(e,args[0],&mode));char pass[256];size_t passLength;Check(napi_get_value_string_utf8(e,args[3],pass,sizeof(pass),&passLength));
 using Pointer=ncrypto::DeleteFnPtr<PKCS12,PKCS12_free>;Pointer p12;
 if(mode==0){p12.reset(PKCS12_init(NID_pkcs7_data));auto* safes=sk_PKCS7_new_null();if(!p12||!safes)throw std::runtime_error("PKCS12 fixture empty allocation");const int packed=PKCS12_pack_authsafes(p12.get(),safes);sk_PKCS7_free(safes);if(!packed||!PKCS12_set_mac(p12.get(),pass,int(passLength),nullptr,0,0,nullptr))throw std::runtime_error("PKCS12 fixture empty encoding");}
 else{void* data;size_t length;Span(e,args[1],&data,&length);auto bio=kandelo::crypto::LoadPKCS12BIO(static_cast<unsigned char*>(data),length);char original[64];size_t size;Check(napi_get_value_string_utf8(e,args[2],original,sizeof(original),&size));auto parsed=kandelo::crypto::ParseCryptoPKCS12(bio,original);p12.reset(PKCS12_create(pass,"actual-key-only",parsed.key.get(),nullptr,nullptr,0,0,0,0,0));if(!p12)throw std::runtime_error("PKCS12 fixture key-only encoding");}
 auto out=ncrypto::BIOPointer::NewMem();if(!out||i2d_PKCS12_bio(out.get(),p12.get())!=1)throw std::runtime_error("PKCS12 fixture DER");return Encoded(e,std::move(out));}catch(const std::exception& error){napi_throw_error(e,nullptr,error.what());return nullptr;}}
static napi_value Init(napi_env e,napi_value exports){napi_value fn;Check(napi_create_function(e,"parse",NAPI_AUTO_LENGTH,Parse,nullptr,&fn));Set(e,exports,"parse",fn);Check(napi_create_function(e,"variant",NAPI_AUTO_LENGTH,Variant,nullptr,&fn));Set(e,exports,"variant",fn);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
