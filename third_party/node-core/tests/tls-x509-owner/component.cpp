// Real N-API owner over the actual production X509Material. This component
// supplies declared prototype/copy/error conversion dependencies; not SM JSAPI.
#include <node_api.h>
#include "x509-operations.h"
#include "socket-owner.h"
#include <arpa/inet.h>
#include <fcntl.h>
#include <chrono>
#include <poll.h>
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <mutex>
using Material=kandelo::crypto::X509Material;
static const napi_type_tag tag{0xe4de97ed5abc9ce1,0x8c8f83bfc0ac9354};
struct Env{napi_ref setPrototype;std::shared_ptr<kandelo::memory::Account> account=std::make_shared<kandelo::memory::Account>();};
struct Box{std::shared_ptr<Material> material;kandelo::memory::Claim claim;Box(std::shared_ptr<Material> m,Env* e):material(std::move(m)),claim(material->Record(),e->account){}};
static unsigned boxes=0;static std::vector<std::weak_ptr<Material>> materials;
static void Check(napi_status value){if(value!=napi_ok)throw std::runtime_error("NAPI component conversion failed");}
static napi_value Undefined(napi_env env){napi_value v;Check(napi_get_undefined(env,&v));return v;}
static napi_value Text(napi_env env,const std::string& s){napi_value v;Check(napi_create_string_utf8(env,s.data(),s.size(),&v));return v;}
static napi_value Number(napi_env env,double n){napi_value v;Check(napi_create_double(env,n,&v));return v;}
static napi_value Boolean(napi_env env,bool b){napi_value v;Check(napi_get_boolean(env,b,&v));return v;}
static void Set(napi_env env,napi_value o,const char*name,napi_value v){Check(napi_set_named_property(env,o,name,v));}
static std::string String(napi_env env,napi_value value){size_t length;Check(napi_get_value_string_utf8(env,value,nullptr,0,&length));std::string s(length+1,0);Check(napi_get_value_string_utf8(env,value,s.data(),s.size(),&length));s.resize(length);return s;}
static Box* Get(napi_env env,napi_value value){if(!value)return nullptr;napi_valuetype type;Check(napi_typeof(env,value,&type));if(type!=napi_object)return nullptr;bool is=false;if(napi_check_object_type_tag(env,value,&tag,&is)!=napi_ok||!is)return nullptr;void* ptr;Check(napi_unwrap(env,value,&ptr));return static_cast<Box*>(ptr);}
static void Finalize(napi_env,void* ptr,void*){delete static_cast<Box*>(ptr);--boxes;}
static size_t ElementSize(napi_typedarray_type type){switch(type){case napi_int8_array:case napi_uint8_array:case napi_uint8_clamped_array:return 1;case napi_int16_array:case napi_uint16_array:return 2;case napi_int32_array:case napi_uint32_array:case napi_float32_array:return 4;default:return 8;}}
static void Span(napi_env env,napi_value value,void**data,size_t*length){bool is=false;Check(napi_is_dataview(env,value,&is));if(is){napi_value buffer;size_t offset;Check(napi_get_dataview_info(env,value,length,data,&buffer,&offset));return;}Check(napi_is_typedarray(env,value,&is));if(is){napi_typedarray_type type;napi_value buffer;size_t offset,count;Check(napi_get_typedarray_info(env,value,&type,&count,data,&buffer,&offset));*length=count*ElementSize(type);return;}throw kandelo::crypto::X509Error("Invalid native X509 input","ERR_INVALID_ARG_TYPE");}
static napi_value Error(napi_env env,const kandelo::crypto::Error& e){napi_value o;Check(napi_create_object(env,&o));Set(env,o,"message",Text(env,e.what()));if(!e.code.empty())Set(env,o,"code",Text(env,e.code));if(!e.library.empty())Set(env,o,"library",Text(env,e.library));if(!e.reason.empty())Set(env,o,"reason",Text(env,e.reason));if(!e.stack.empty()){napi_value list;Check(napi_create_array_with_length(env,e.stack.size(),&list));for(size_t i=0;i<e.stack.size();++i)Check(napi_set_element(env,list,i,Text(env,e.stack[i])));Set(env,o,"opensslErrorStack",list);}return o;}
static napi_value Wrap(napi_env env, Env* e, napi_value prototype, std::shared_ptr<Material> material) {
 auto box=std::make_unique<Box>(std::move(material),e);napi_value value,setProto,ignored;
 Check(napi_create_object(env,&value));Check(napi_get_reference_value(env,e->setPrototype,&setProto));
 napi_value args[]={value,prototype};Check(napi_call_function(env,Undefined(env),setProto,2,args,&ignored));
 Check(napi_type_tag_object(env,value,&tag));Check(napi_wrap(env,value,box.get(),Finalize,nullptr,nullptr));
 materials.emplace_back(box->material);box.release();++boxes;return value;
}
static napi_value Operation(napi_env env,napi_callback_info info){size_t argc=8;napi_value argv[8];void*userdata;Check(napi_get_cb_info(env,info,&argc,argv,nullptr,&userdata));auto*e=static_cast<Env*>(userdata);napi_value value=Undefined(env),error=Undefined(env);ncrypto::MarkPopErrorOnReturn mark;
 try{const auto op=String(env,argv[0]);
  if(op=="constants"){Check(napi_create_object(env,&value));const struct{const char*name;unsigned v;}entries[]={{"X509_CHECK_FLAG_ALWAYS_CHECK_SUBJECT",X509_CHECK_FLAG_ALWAYS_CHECK_SUBJECT},{"X509_CHECK_FLAG_NEVER_CHECK_SUBJECT",X509_CHECK_FLAG_NEVER_CHECK_SUBJECT},{"X509_CHECK_FLAG_NO_WILDCARDS",X509_CHECK_FLAG_NO_WILDCARDS},{"X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS",X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS},{"X509_CHECK_FLAG_MULTI_LABEL_WILDCARDS",X509_CHECK_FLAG_MULTI_LABEL_WILDCARDS},{"X509_CHECK_FLAG_SINGLE_LABEL_SUBDOMAINS",X509_CHECK_FLAG_SINGLE_LABEL_SUBDOMAINS}};for(const auto& x:entries)Set(env,value,x.name,Number(env,x.v));}
  else if(op=="is")value=Boolean(env,argc>1&&Get(env,argv[1]));
  else if(op=="stats"){Check(napi_create_object(env,&value));unsigned alive=0;for(auto&ref:materials)alive+=!ref.expired();Set(env,value,"boxes",Number(env,boxes));Set(env,value,"materials",Number(env,alive));Set(env,value,"ledger",Number(env,kandelo::memory::processLedger.Inspect().retained));Set(env,value,"openssl",Text(env,OpenSSL_version(OPENSSL_VERSION)));}
  else if(op=="create"){
   std::shared_ptr<Material> material;if(auto*box=Get(env,argv[2]))material=box->material;
   else{void*data;size_t length;Span(env,argv[2],&data,&length);material=Material::Parse(static_cast<unsigned char*>(data),length,e->account);materials.emplace_back(material);}
   auto box=std::make_unique<Box>(std::move(material),e);Check(napi_create_object(env,&value));napi_value setProto,ignored;Check(napi_get_reference_value(env,e->setPrototype,&setProto));napi_value args[]={value,argv[1]};Check(napi_call_function(env,Undefined(env),setProto,2,args,&ignored));Check(napi_type_tag_object(env,value,&tag));Check(napi_wrap(env,value,box.get(),Finalize,nullptr,nullptr));box.release();++boxes;
  }else{
   auto*box=Get(env,argv[1]);if(!box)throw kandelo::crypto::X509Error("Value of this must be of type X509Certificate","ERR_INVALID_THIS");auto&cert=*box->material;
   if(op=="getIssuerCert") { auto issuer=cert.Issuer();if(issuer){napi_value prototype;Check(napi_get_prototype(env,argv[1],&prototype));value=Wrap(env,e,prototype,std::move(issuer));} }
   else if(op=="checkCA")value=Boolean(env,cert.CA());
   else if(op=="checkIssued"){auto*other=Get(env,argv[2]);if(!other)throw std::runtime_error("component issuer owner");value=Boolean(env,cert.View().isIssuedBy(other->material->View()));}
   else if(op=="checkPrivateKeyPem"||op=="verifyPem"){const auto pem=String(env,argv[2]);auto bio=ncrypto::BIOPointer(BIO_new_mem_buf(pem.data(),int(pem.size())));ncrypto::EVPKeyPointer key(op=="checkPrivateKeyPem"?PEM_read_bio_PrivateKey(bio.get(),nullptr,nullptr,nullptr):PEM_read_bio_PUBKEY(bio.get(),nullptr,nullptr,nullptr));if(!key)throw std::runtime_error("component key conversion");value=Boolean(env,op=="checkPrivateKeyPem"?cert.View().checkPrivateKey(key):cert.View().checkPublicKey(key));}
   else if(op=="validFromDate"||op=="validToDate")Check(napi_create_date(env,cert.Date(op=="validFromDate"),&value));
   else if(op=="keyUsage"){auto list=cert.KeyUsage();if(list){Check(napi_create_array_with_length(env,list->size(),&value));for(size_t i=0;i<list->size();++i)Check(napi_set_element(env,value,i,Text(env,(*list)[i])));}}
   else if(op=="raw"){auto bytes=cert.Raw();if(bytes){void*data;Check(napi_create_buffer_copy(env,bytes->size(),bytes->data(),&data,&value));}}
   else if(op=="publicKeyPem"){auto key=cert.PublicKey();auto bio=ncrypto::BIOPointer::NewMem();if(!bio||PEM_write_bio_PUBKEY(bio.get(),key.get())!=1)throw std::runtime_error("component public key encoding");BUF_MEM*mem=bio;value=Text(env,std::string(mem->data,mem->length));}
   else{auto text=cert.String(op);if(text)value=Text(env,*text);}
  }
 }catch(const kandelo::crypto::Error& failure){error=Error(env,failure);}catch(const std::exception&failure){napi_throw_error(env,nullptr,failure.what());return nullptr;}
 napi_value packet;Check(napi_create_object(env,&packet));Set(env,packet,"value",value);Set(env,packet,"error",error);return packet;
}
struct Session {
 kandelo::socket::Owner tcp{81},peer{82};
 ncrypto::SSLCtxPointer context{SSL_CTX_new(TLS_client_method())},serverContext{SSL_CTX_new(TLS_server_method())};
 ncrypto::SSLPointer client,server;
 bool handshaken=false;
 void Close(){client.reset();server.reset();context.reset();serverContext.reset();tcp.Close();peer.Close();}
 ~Session(){Close();}
};
static const napi_type_tag sessionTag{0x6d72549ff1e82a63,0x153478f58c2ee09b};
static Session* GetSession(napi_env env,napi_value value){bool is=false;Check(napi_check_object_type_tag(env,value,&sessionTag,&is));if(!is)throw std::runtime_error("actual native SSL session required");void* ptr;Check(napi_unwrap(env,value,&ptr));return static_cast<Session*>(ptr);}
static void SocketPair(Session& s){
 kandelo::socket::Lease listener(socket(AF_INET,SOCK_STREAM,0));if(listener.Fd()<0)throw std::runtime_error("listener");
 sockaddr_in address={};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
 if(bind(listener.Fd(),reinterpret_cast<sockaddr*>(&address),sizeof(address))||listen(listener.Fd(),1))throw std::runtime_error("bind/listen");
 socklen_t length=sizeof(address);if(getsockname(listener.Fd(),reinterpret_cast<sockaddr*>(&address),&length))throw std::runtime_error("address");
 kandelo::socket::Lease client(socket(AF_INET,SOCK_STREAM,0));if(client.Fd()<0||connect(client.Fd(),reinterpret_cast<sockaddr*>(&address),length))throw std::runtime_error("connect");
 kandelo::socket::Lease peer(accept(listener.Fd(),nullptr,nullptr));if(peer.Fd()<0)throw std::runtime_error("accept");
 for(int fd:{client.Fd(),peer.Fd()}){int flags=fcntl(fd,F_GETFL);if(flags<0||fcntl(fd,F_SETFL,flags|O_NONBLOCK))throw std::runtime_error("nonblocking");}
 if(!s.tcp.Adopt(client)||!s.peer.Adopt(peer))throw std::runtime_error("actual socket lease adoption");
}
static napi_value SessionOperation(napi_env env,napi_callback_info info){try{
 size_t argc=6;napi_value argv[6];void* data;Check(napi_get_cb_info(env,info,&argc,argv,nullptr,&data));auto* e=static_cast<Env*>(data);
 const auto op=String(env,argv[0]);
 if(op=="create"){
  auto out=std::make_unique<Session>();if(!out->context||!out->serverContext)throw std::runtime_error("SSL_CTX_new");
  const auto certText=String(env,argv[1]),keyText=String(env,argv[2]),caText=String(env,argv[3]);
  ncrypto::BIOPointer cb(BIO_new_mem_buf(certText.data(),int(certText.size()))),kb(BIO_new_mem_buf(keyText.data(),int(keyText.size()))),ab(BIO_new_mem_buf(caText.data(),int(caText.size())));
  ncrypto::X509Pointer cert(PEM_read_bio_X509(cb.get(),nullptr,nullptr,nullptr)),ca(PEM_read_bio_X509(ab.get(),nullptr,nullptr,nullptr));
  ncrypto::EVPKeyPointer key(PEM_read_bio_PrivateKey(kb.get(),nullptr,nullptr,nullptr));
  if(!cert||!ca||!key)throw std::runtime_error("actual fixture certificate/key/CA");
  for(SSL_CTX* ctx:{out->context.get(),out->serverContext.get()})
   if(SSL_CTX_use_certificate(ctx,cert.get())!=1||SSL_CTX_use_PrivateKey(ctx,key.get())!=1)throw std::runtime_error("actual configured local certificate");
  auto extra=ncrypto::X509View(ca.get()).clone();if(!extra||SSL_CTX_add_extra_chain_cert(out->serverContext.get(),extra.get())!=1)throw std::runtime_error("server chain");extra.release();
  out->client=ncrypto::SSLPointer(SSL_new(out->context.get()));out->server=ncrypto::SSLPointer(SSL_new(out->serverContext.get()));
  if(!out->client||!out->server)throw std::runtime_error("SSL_new");SocketPair(*out);
  if(SSL_set_fd(out->client.get(),out->tcp.Fd())!=1||SSL_set_fd(out->server.get(),out->peer.Fd())!=1)throw std::runtime_error("direct actual BIO");
  SSL_set_connect_state(out->client.get());SSL_set_accept_state(out->server.get());
  napi_value value;Check(napi_create_object(env,&value));Check(napi_type_tag_object(env,value,&sessionTag));Check(napi_wrap(env,value,out.get(),[](napi_env,void*ptr,void*){delete static_cast<Session*>(ptr);},nullptr,nullptr));out.release();return value;
 }
 auto* session=GetSession(env,argv[1]);
 if(op=="handshake"){
  const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(4);bool client=false,server=false;
  while(!client||!server){if(std::chrono::steady_clock::now()>deadline)throw std::runtime_error("handshake timeout");
   for(auto item:{std::pair<SSL*,bool*>{session->client.get(),&client},{session->server.get(),&server}}){if(*item.second)continue;ERR_clear_error();int result=item.first==session->client.get()?SSL_connect(item.first):SSL_accept(item.first);if(result==1)*item.second=true;else{int error=SSL_get_error(item.first,result);if(error!=SSL_ERROR_WANT_READ&&error!=SSL_ERROR_WANT_WRITE)throw std::runtime_error("real handshake error");}}}
  session->handshaken=true;return Undefined(env);
 }
 if(op=="close"){session->Close();return Undefined(env);}
 if(op=="ownership"){
  bool local=false;Check(napi_get_value_bool(env,argv[2],&local));
  auto material=Material::FromTLS(session->client.get(),local,e->account);
  const X509* borrowed=local?SSL_get_certificate(session->client.get()):SSL_get0_peer_certificate(session->client.get());
  return Boolean(env,material&&borrowed&&material->View().get()!=borrowed);
 }
 if(op=="certificate"){
  bool local=false,server=false;Check(napi_get_value_bool(env,argv[2],&local));if(argc>4)Check(napi_get_value_bool(env,argv[4],&server));
  auto material=Material::FromTLS(server?session->server.get():session->client.get(),local,e->account);
  return material?Wrap(env,e,argv[3],std::move(material)):Undefined(env);
 }
 throw std::runtime_error("unknown session operation");
 }catch(const std::exception& error){napi_throw_error(env,nullptr,error.what());return nullptr;}}
static napi_value Init(napi_env env,napi_value exports){auto*e=new Env;napi_value global,object,setProto,fn;Check(napi_get_global(env,&global));Check(napi_get_named_property(env,global,"Object",&object));Check(napi_get_named_property(env,object,"setPrototypeOf",&setProto));Check(napi_create_reference(env,setProto,1,&e->setPrototype));Check(napi_set_instance_data(env,e,[](napi_env env,void*ptr,void*){auto*e=static_cast<Env*>(ptr);e->account->Detach();napi_delete_reference(env,e->setPrototype);delete e;},nullptr));Check(napi_create_function(env,"x509Operation",NAPI_AUTO_LENGTH,Operation,e,&fn));Set(env,exports,"x509Operation",fn);Check(napi_create_function(env,"session",NAPI_AUTO_LENGTH,SessionOperation,e,&fn));Set(env,exports,"session",fn);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
