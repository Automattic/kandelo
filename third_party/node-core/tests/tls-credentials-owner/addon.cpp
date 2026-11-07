// Test-only N-API bridge to the actual credential/context source. Production
// uses native-tls-context.cpp and its own realm/GC/handshake owners.
#include <node_api.h>
#include "../crypto-errors/napi-error.h"
#include "kandelo-node-tls-credential-operations.h"
#include "kandelo-node-tls-context-trust.h"
#include <atomic>
#include <stdexcept>
using namespace kandelo::tls;
struct Owner { ContextPointer context; ncrypto::X509Pointer certificate,issuer; explicit Owner(ContextPointer ctx):context(std::move(ctx)){} };
static size_t live=0;
static void Check(napi_status value){if(value!=napi_ok)throw std::runtime_error("TLS component NAPI conversion");}
static napi_value Text(napi_env e,const char* text){napi_value v;Check(napi_create_string_utf8(e,text,NAPI_AUTO_LENGTH,&v));return v;}
static napi_value Num(napi_env e,int n){napi_value v;Check(napi_create_int32(e,n,&v));return v;}
static void Set(napi_env e,napi_value object,const char* name,napi_value value){Check(napi_set_named_property(e,object,name,value));}
static napi_value Throw(napi_env e,const kandelo::crypto::Error& error,bool type=false){
 auto value=kandelo::crypto::test::MakeError(e,error,type?std::optional(kandelo::crypto::ErrorKind::TypeError):std::nullopt);
 if(!value)return nullptr;Check(napi_throw(e,value));return nullptr;
}

static void Finalize(napi_env,void* p,void*){delete static_cast<Owner*>(p);--live;}
static Owner* Unwrap(napi_env e,napi_value object){Owner* value;Check(napi_unwrap(e,object,reinterpret_cast<void**>(&value)));return value;}
// Capturing native typed storage here is a host component transport seam;
// SpiderMonkey production admission is independently rooted/realm checked.
static bool Input(napi_env e,napi_value input,kandelo::crypto::Bytes& bytes,bool terminate=false){
 napi_valuetype type;Check(napi_typeof(e,input,&type));
 if(type==napi_string){size_t size;Check(napi_get_value_string_utf8(e,input,nullptr,0,&size));bytes.value.resize(size+1);Check(napi_get_value_string_utf8(e,input,reinterpret_cast<char*>(bytes.value.data()),size+1,&size));bytes.value.resize(size);return true;}
 bool view;Check(napi_is_dataview(e,input,&view));void* data;size_t length,offset;napi_value buffer;
 if(view){Check(napi_get_dataview_info(e,input,&length,&data,&buffer,&offset));}
 else{Check(napi_is_typedarray(e,input,&view));if(!view)return false;napi_typedarray_type array;size_t count;Check(napi_get_typedarray_info(e,input,&array,&count,&data,&buffer,&offset));size_t width=array==napi_float16_array?2:array<=napi_uint8_clamped_array?1:array<=napi_uint16_array?2:array<=napi_float32_array?4:8;length=count*width;}
 bytes.value.resize(length+(terminate?1:0));for(size_t i=0;i<length;++i)bytes.value[i]=__atomic_load_n(static_cast<unsigned char*>(data)+i,__ATOMIC_RELAXED);if(terminate)bytes.value[length]=0;return true;
}
static napi_value Operation(napi_env e,napi_callback_info info){try{
 size_t argc=4;napi_value args[4];Check(napi_get_cb_info(e,info,&argc,args,nullptr,nullptr));char op[32];size_t written;Check(napi_get_value_string_utf8(e,args[0],op,sizeof(op),&written));napi_value result;Check(napi_get_undefined(e,&result));
 if(!strcmp(op,"create")){ERR_clear_error();auto context=NewTrustContext();if(!context)credentials::CryptoFailure("context allocation");auto owner=std::make_unique<Owner>(std::move(context));Check(napi_create_object(e,&result));Check(napi_wrap(e,result,owner.get(),Finalize,nullptr,nullptr));++live;owner.release();return result;}
 Owner* owner=Unwrap(e,args[1]);
 if(!strcmp(op,"addDefault")){AddDefaultTrust(owner->context.get());return result;}
 if(!strcmp(op,"partial")){if(!AllowPartialTrustChain(owner->context.get()))credentials::CryptoFailure("partial trust");return result;}
 kandelo::crypto::Bytes bytes,password;bool admitted=Input(e,args[2],bytes);
 if(!strcmp(op,"addCA")){if(!admitted)throw std::runtime_error("CA admission");unsigned long failure=0;if(!AddTrustCertificates(owner->context.get(),bytes.value.data(),bytes.value.size(),&failure))credentials::CryptoFailure("CA rejected");}
 else if(!strcmp(op,"setCert")){if(admitted)credentials::SetCertificate(owner->context.get(),owner->certificate,owner->issuer,bytes.value.data(),bytes.value.size());}
 else if(!strcmp(op,"setKey")){if(admitted){napi_valuetype type;Check(napi_typeof(e,args[3],&type));if(type==napi_string)Input(e,args[3],password);credentials::SetPrivateKey(owner->context.get(),bytes.value.data(),bytes.value.size(),password.value.data(),password.value.size());}}
 else if(!strcmp(op,"loadPFX")){ncrypto::ClearErrorOnReturn clear;auto bio=credentials::LoadPFXBIO(bytes.value.data(),bytes.value.size(),admitted);const char* pass=nullptr;
  if(argc==4){bool passAdmitted=Input(e,args[3],password,true);napi_valuetype type;Check(napi_typeof(e,args[3],&type));if(!passAdmitted||type==napi_string){kandelo::crypto::X509Error error("Pass phrase must be a buffer","ERR_INVALID_ARG_TYPE");return Throw(e,error,true);}pass=reinterpret_cast<const char*>(password.value.data());}
  credentials::LoadPFX(owner->context.get(),owner->certificate,owner->issuer,bio,pass);
 }else throw std::runtime_error("Unknown TLS component operation");
 return result;
}catch(const kandelo::crypto::Error& error){return Throw(e,error);}catch(const std::exception& error){napi_throw_error(e,nullptr,error.what());return nullptr;}}
static napi_value Der(napi_env e,X509* cert){if(!cert){napi_value value;Check(napi_get_null(e,&value));return value;}auto out=ncrypto::X509View(cert).toDER();if(!out)credentials::CryptoFailure("certificate DER");BUF_MEM* memory=out;napi_value bytes;void* copy;Check(napi_create_buffer_copy(e,memory->length,memory->data,&copy,&bytes));return bytes;}
static napi_value Snapshot(napi_env e,napi_callback_info info){try{size_t argc=1;napi_value arg,result;Check(napi_get_cb_info(e,info,&argc,&arg,nullptr,nullptr));auto* owner=Unwrap(e,arg);Check(napi_create_object(e,&result));Set(e,result,"certificate",Der(e,owner->certificate.get()));Set(e,result,"issuer",Der(e,owner->issuer.get()));Set(e,result,"installed",Der(e,SSL_CTX_get0_certificate(owner->context.get())));STACK_OF(X509)* chain=nullptr;SSL_CTX_get0_chain_certs(owner->context.get(),&chain);Set(e,result,"chainCount",Num(e,chain?sk_X509_num(chain):0));return result;}catch(const std::exception& error){napi_throw_error(e,nullptr,error.what());return nullptr;}}
static napi_value Live(napi_env e,napi_callback_info){return Num(e,live);}
// A real independent SSL_CTX ref models the existing handshake claim. It owns
// no JS root or fake key/certificate metadata after the original wrapper dies.
static napi_value Claim(napi_env e,napi_callback_info info){try{size_t argc=1;napi_value arg,result;Check(napi_get_cb_info(e,info,&argc,&arg,nullptr,nullptr));auto* original=Unwrap(e,arg);if(SSL_CTX_up_ref(original->context.get())!=1)credentials::CryptoFailure("context reference");auto owner=std::make_unique<Owner>(ContextPointer(original->context.get()));Check(napi_create_object(e,&result));Check(napi_wrap(e,result,owner.get(),Finalize,nullptr,nullptr));++live;owner.release();return result;}catch(const std::exception& error){napi_throw_error(e,nullptr,error.what());return nullptr;}}
static napi_value Handshake(napi_env e,napi_callback_info info){try{
 size_t argc=4;napi_value args[4];Check(napi_get_cb_info(e,info,&argc,args,nullptr,nullptr));Owner* owner=Unwrap(e,args[0]);
 kandelo::crypto::Bytes cert,key,ca;Input(e,args[1],cert);Input(e,args[2],key);Input(e,args[3],ca);
 ContextPointer server(SSL_CTX_new(TLS_server_method()));if(!server)credentials::CryptoFailure("server fixture context");
 ncrypto::X509Pointer serverCert,serverIssuer;credentials::SetCertificate(server.get(),serverCert,serverIssuer,cert.value.data(),cert.value.size());credentials::SetPrivateKey(server.get(),key.value.data(),key.value.size(),nullptr,0);
 if(!AddTrustCertificates(server.get(),ca.value.data(),ca.value.size()))credentials::CryptoFailure("server fixture trust");
 SSL_CTX_set_verify(server.get(),SSL_VERIFY_PEER|SSL_VERIFY_FAIL_IF_NO_PEER_CERT,nullptr);
 using SSLPointer=std::unique_ptr<SSL,decltype(&SSL_free)>;
 SSLPointer client(SSL_new(owner->context.get()),SSL_free),peer(SSL_new(server.get()),SSL_free);
 if(!client||!peer)credentials::CryptoFailure("handshake fixture SSL");
 SSL_set_verify(client.get(),SSL_VERIFY_PEER,nullptr);
 BIO *clientBio=nullptr,*serverBio=nullptr;
 if(BIO_new_bio_pair(&clientBio,0,&serverBio,0)!=1){BIO_free(clientBio);BIO_free(serverBio);credentials::CryptoFailure("handshake fixture BIO pair");}
 SSL_set_bio(client.get(),clientBio,clientBio);SSL_set_bio(peer.get(),serverBio,serverBio);
 SSL_set_connect_state(client.get());SSL_set_accept_state(peer.get());
 bool failed=false;std::string reason;
 for(unsigned turns=0;turns<100&&!failed&&(!SSL_is_init_finished(client.get())||!SSL_is_init_finished(peer.get()));++turns){
  for(SSL* ssl:{client.get(),peer.get()}){
   if(SSL_is_init_finished(ssl))continue;
   int result=SSL_do_handshake(ssl);if(result==1)continue;
   int error=SSL_get_error(ssl,result);
   if(error!=SSL_ERROR_WANT_READ&&error!=SSL_ERROR_WANT_WRITE){failed=true;unsigned long code=ERR_get_error();const char* text=ERR_reason_error_string(code);reason=text?text:"handshake did not complete";break;}
  }
 }
 const bool completed=!failed&&SSL_is_init_finished(client.get())&&SSL_is_init_finished(peer.get());
 napi_value result;Check(napi_create_object(e,&result));Set(e,result,"completed",Num(e,completed));Set(e,result,"reason",Text(e,reason.c_str()));
 if(completed){
  Set(e,result,"protocol",Text(e,SSL_get_version(client.get())));Set(e,result,"clientVerify",Num(e,SSL_get_verify_result(client.get())));Set(e,result,"serverVerify",Num(e,SSL_get_verify_result(peer.get())));
  ncrypto::X509Pointer clientCert(SSL_get1_peer_certificate(peer.get())),peerCert(SSL_get1_peer_certificate(client.get()));Set(e,result,"clientCertificate",Der(e,clientCert.get()));Set(e,result,"serverCertificate",Der(e,peerCert.get()));
  const char payload[]="actual credential owner";char received[sizeof(payload)]{};
  if(SSL_write(client.get(),payload,sizeof(payload))!=sizeof(payload)||SSL_read(peer.get(),received,sizeof(received))!=sizeof(received)||memcmp(payload,received,sizeof(payload)))throw std::runtime_error("real encrypted payload mismatch");
  Set(e,result,"actualEncryptedPayload",Num(e,1));
 }
 ERR_clear_error();return result;
}catch(const kandelo::crypto::Error& error){return Throw(e,error);}catch(const std::exception& error){napi_throw_error(e,nullptr,error.what());return nullptr;}}
static napi_value Init(napi_env e,napi_value exports){for(const auto& method:std::initializer_list<std::pair<const char*,napi_callback>>{{"operation",Operation},{"snapshot",Snapshot},{"claim",Claim},{"live",Live},{"handshake",Handshake}}){napi_value fn;Check(napi_create_function(e,method.first,NAPI_AUTO_LENGTH,method.second,nullptr,&fn));Set(e,exports,method.first,fn);}return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
