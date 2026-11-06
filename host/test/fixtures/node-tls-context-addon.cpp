// NAPI fixture for the actual portable trust owner and real local TCP/TLS.
// It does not compile or execute the production SpiderMonkey JSAPI bridge.
#include <node_api.h>
#include "kandelo-node-tls-context-trust.h"
#include "kandelo-node-tls-state.h"
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <atomic>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
namespace {
const napi_type_tag Tag{0x825e41747e9c5e19ULL,0x62f09bf1378b4891ULL};
std::atomic<int> Holders{0};
struct Owner {
  kandelo::tls::ContextPointer context;
  Owner():context(kandelo::tls::NewTrustContext()){Holders++;}
  ~Owner(){Holders--;}
};
void Check(napi_status s){if(s!=napi_ok)throw std::runtime_error("NAPI fixture API failure");}
napi_value Text(napi_env e,const std::string& s){napi_value v;Check(napi_create_string_utf8(e,s.data(),s.size(),&v));return v;}
napi_value Boolean(napi_env e,bool b){napi_value v;Check(napi_get_boolean(e,b,&v));return v;}
napi_value Number(napi_env e,int32_t n){napi_value v;Check(napi_create_int32(e,n,&v));return v;}
void Own(napi_env e,napi_value o,const char* n,napi_value v){napi_property_descriptor p{n,nullptr,nullptr,nullptr,nullptr,v,napi_default_jsproperty,nullptr};Check(napi_define_properties(e,o,1,&p));}
std::string String(napi_env e,napi_value v){size_t n,w;Check(napi_get_value_string_utf8(e,v,nullptr,0,&n));std::string s(n+1,'\0');Check(napi_get_value_string_utf8(e,v,s.data(),s.size(),&w));s.resize(w);return s;}
Owner* Unwrap(napi_env e,napi_value value){bool yes=false;Check(napi_check_object_type_tag(e,value,&Tag,&yes));if(!yes)throw std::runtime_error("Invalid fixture context brand");void* p;Check(napi_unwrap(e,value,&p));auto* o=static_cast<Owner*>(p);if(!o||!o->context)throw std::runtime_error("Closed fixture context");return o;}
void Finalize(napi_env,void* data,void*){delete static_cast<Owner*>(data);}
std::vector<unsigned char> Bytes(napi_env e,napi_value v){
 napi_valuetype type;Check(napi_typeof(e,v,&type));
 if(type==napi_string){auto s=String(e,v);return {s.begin(),s.end()};}
 bool dataView=false;Check(napi_is_dataview(e,v,&dataView));size_t length,offset;void* data;napi_value buffer;
 if(dataView){Check(napi_get_dataview_info(e,v,&length,&data,&buffer,&offset));}
 else{
  bool typed;Check(napi_is_typedarray(e,v,&typed));if(!typed)throw std::runtime_error("Fixture CA must be an actual view");
  napi_typedarray_type kind;Check(napi_get_typedarray_info(e,v,&kind,&length,&data,&buffer,&offset));
  size_t width=1;switch(kind){case napi_int16_array:case napi_uint16_array:case napi_float16_array:width=2;break;case napi_int32_array:case napi_uint32_array:case napi_float32_array:width=4;break;case napi_float64_array:case napi_bigint64_array:case napi_biguint64_array:width=8;break;default:break;}
  if(length>SIZE_MAX/width)throw std::bad_alloc();length*=width;
 }
 std::vector<unsigned char> out(length);auto* source=static_cast<unsigned char*>(data);
 for(size_t i=0;i<length;i++)out[i]=__atomic_load_n(source+i,__ATOMIC_RELAXED);return out;
}
napi_value Context(napi_env e,napi_callback_info info){try{
 size_t count=3;napi_value a[3];Check(napi_get_cb_info(e,info,&count,a,nullptr,nullptr));if(!count)throw std::runtime_error("Missing fixture operation");auto op=String(e,a[0]);napi_value result;
 if(op=="create"){
  auto owner=std::make_unique<Owner>();if(!owner->context)throw std::runtime_error("SSL_CTX_new failed");Check(napi_create_object(e,&result));Check(napi_type_tag_object(e,result,&Tag));Check(napi_wrap(e,result,owner.get(),Finalize,nullptr,nullptr));owner.release();return result;
 }
 if(op=="version")return Text(e,OpenSSL_version(OPENSSL_VERSION));
 if(op=="holders")return Number(e,Holders.load());
 if(count<2)throw std::runtime_error("Missing fixture context");auto* owner=Unwrap(e,a[1]);
 if(op=="addCA"){
  if(count!=3)throw std::runtime_error("Missing CA");auto bytes=Bytes(e,a[2]);unsigned long error=0;
  if(!kandelo::tls::AddTrustCertificates(owner->context.get(),bytes.data(),bytes.size(),&error)){char text[256];ERR_error_string_n(error,text,sizeof text);throw std::runtime_error(text);}
 }else if(op=="addDefault")kandelo::tls::AddDefaultTrust(owner->context.get());
 else if(op=="partial"){if(!kandelo::tls::AllowPartialTrustChain(owner->context.get()))throw std::runtime_error("partial trust flag failed");}
 else if(op=="close")owner->context.reset();
 else if(op=="info"){
  Check(napi_create_object(e,&result));auto* objects=X509_STORE_get0_objects(SSL_CTX_get_cert_store(owner->context.get()));
  Own(e,result,"storeObjects",Number(e,sk_X509_OBJECT_num(objects)));auto* names=SSL_CTX_get_client_CA_list(owner->context.get());Own(e,result,"clientCAList",Number(e,names?sk_X509_NAME_num(names):0));
  Own(e,result,"partial",Boolean(e,(X509_VERIFY_PARAM_get_flags(X509_STORE_get0_param(SSL_CTX_get_cert_store(owner->context.get())))&X509_V_FLAG_PARTIAL_CHAIN)!=0));return result;
 }else throw std::runtime_error("Unknown fixture context operation");
 Check(napi_get_undefined(e,&result));return result;
 }catch(const std::exception& error){napi_throw_error(e,nullptr,error.what());return nullptr;}}
struct Work {
 SSL_CTX* context=nullptr;napi_async_work work=nullptr;napi_deferred deferred=nullptr;
 uint32_t port=0;bool reject=true,connected=false,authorized=false;long verify=X509_V_OK;std::string host,error,code,protocol,verifyMessage;
 ~Work(){if(context)SSL_CTX_free(context);}
};
void Execute(napi_env,void* data){auto* w=static_cast<Work*>(data);int fd=-1;SSL* ssl=nullptr;try{
 fd=socket(AF_INET,SOCK_STREAM,0);if(fd<0)throw std::runtime_error("socket failed");timeval timeout{4,0};setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof timeout);setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof timeout);
 sockaddr_in address{};address.sin_family=AF_INET;address.sin_port=htons(w->port);inet_pton(AF_INET,"127.0.0.1",&address.sin_addr);
 if(connect(fd,reinterpret_cast<sockaddr*>(&address),sizeof address)!=0)throw std::runtime_error("connect failed");
 ssl=SSL_new(w->context);if(!ssl)throw std::runtime_error("SSL_new failed");
 SSL_set_verify(ssl,SSL_VERIFY_NONE,kandelo::tls::ContinueVerification);
 if(SSL_set_fd(ssl,fd)!=1||(!w->host.empty()&&(SSL_set_tlsext_host_name(ssl,w->host.c_str())!=1||SSL_set1_host(ssl,w->host.c_str())!=1)))throw std::runtime_error("TLS setup failed");
 ERR_clear_error();const int result=SSL_connect(ssl);w->verify=kandelo::tls::VerifyPeer(ssl);w->authorized=w->verify==X509_V_OK;w->connected=result==1&&(!w->reject||w->authorized);
 if(w->verify!=X509_V_OK){w->verifyMessage=kandelo::tls::TrustVerificationReason(int(w->verify));const char* code=kandelo::tls::VerificationErrorCode(int32_t(w->verify));w->code=code?code:"UNKNOWN_VERIFY_ERROR";}
 if(result!=1){char text[256];ERR_error_string_n(ERR_peek_last_error(),text,sizeof text);w->error=text;}
 if(result==1){w->protocol=SSL_get_version(ssl);SSL_shutdown(ssl);}
 }catch(const std::exception& error){w->error=error.what();}
 if(ssl)SSL_free(ssl);if(fd>=0)close(fd);
}
void Complete(napi_env e,napi_status status,void* data){std::unique_ptr<Work>w(static_cast<Work*>(data));try{
 napi_value result;Check(napi_create_object(e,&result));Own(e,result,"connected",Boolean(e,w->connected));Own(e,result,"authorized",Boolean(e,w->authorized));Own(e,result,"code",w->code.empty()?Text(e,"OK"):Text(e,w->code));Own(e,result,"protocol",Text(e,w->protocol));Own(e,result,"nativeError",Text(e,w->error));Own(e,result,"verifyMessage",Text(e,w->verifyMessage));
 if(status==napi_ok)Check(napi_resolve_deferred(e,w->deferred,result));else Check(napi_reject_deferred(e,w->deferred,result));
 }catch(const std::exception& error){napi_value reason; if(napi_create_string_utf8(e,error.what(),NAPI_AUTO_LENGTH,&reason)==napi_ok)napi_reject_deferred(e,w->deferred,reason);}
 napi_delete_async_work(e,w->work);
}
napi_value Connect(napi_env e,napi_callback_info info){try{
 size_t count=4;napi_value a[4];Check(napi_get_cb_info(e,info,&count,a,nullptr,nullptr));if(count!=4)throw std::runtime_error("Fixture connect arguments");auto* owner=Unwrap(e,a[0]);auto w=std::make_unique<Work>();
 Check(napi_get_value_uint32(e,a[1],&w->port));Check(napi_get_value_bool(e,a[2],&w->reject));w->host=String(e,a[3]);if(SSL_CTX_up_ref(owner->context.get())!=1)throw std::runtime_error("SSL_CTX_up_ref failed");w->context=owner->context.get();
 napi_value promise,label=Text(e,"ActualOpenSSLTCPTrustControl");Check(napi_create_promise(e,&w->deferred,&promise));Check(napi_create_async_work(e,nullptr,label,Execute,Complete,w.get(),&w->work));auto status=napi_queue_async_work(e,w->work);if(status!=napi_ok){napi_delete_async_work(e,w->work);Check(status);}w.release();return promise;
 }catch(const std::exception& error){napi_throw_error(e,nullptr,error.what());return nullptr;}}
}
NAPI_MODULE_INIT(){napi_property_descriptor p[]={
 {"context",nullptr,Context,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"connect",nullptr,Connect,nullptr,nullptr,nullptr,napi_default,nullptr}};napi_define_properties(env,exports,2,p);return exports;}
