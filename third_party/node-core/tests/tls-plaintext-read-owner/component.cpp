#include <node_api.h>
#include <algorithm>
#include "tls-owner.h"
#include <openssl/pem.h>
#include <openssl/err.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <chrono>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>
namespace {
int assertions=0;
std::vector<std::string> completedChecks;
void Check(bool ok,const char* message){++assertions;if(!ok)throw std::runtime_error(message);if(std::find(completedChecks.begin(),completedChecks.end(),message)==completedChecks.end())completedChecks.emplace_back(message);}
std::string String(napi_env env,napi_value value){size_t n=0;Check(napi_get_value_string_utf8(env,value,nullptr,0,&n)==napi_ok,"string length");std::string s(n+1,0);Check(napi_get_value_string_utf8(env,value,s.data(),s.size(),&n)==napi_ok,"string bytes");s.resize(n);return s;}
void Freed(void*,void* pointer,CRYPTO_EX_DATA*,int,long,void*){if(pointer)++*static_cast<int*>(pointer);}
struct Pair { kandelo::socket::Lease client,server;int port; };
// Lease deliberately is nonmovable; construct a returnable pair through actual
// unique ownership rather than copying descriptor numbers.
std::unique_ptr<Pair> NewPair(){
 auto out=std::make_unique<Pair>();kandelo::socket::Lease listener(socket(AF_INET,SOCK_STREAM,0));Check(listener.Fd()>=0,"listener socket");sockaddr_in address={};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);Check(bind(listener.Fd(),reinterpret_cast<sockaddr*>(&address),sizeof(address))==0,"bind");Check(listen(listener.Fd(),1)==0,"listen");socklen_t size=sizeof(address);Check(getsockname(listener.Fd(),reinterpret_cast<sockaddr*>(&address),&size)==0,"getsockname");out->port=ntohs(address.sin_port);kandelo::socket::Lease client(socket(AF_INET,SOCK_STREAM,0));Check(client.Fd()>=0,"client");Check(connect(client.Fd(),reinterpret_cast<sockaddr*>(&address),sizeof(address))==0,"connect");kandelo::socket::Lease server(accept(listener.Fd(),nullptr,nullptr));Check(server.Fd()>=0,"accept");for(int fd:{client.Fd(),server.Fd()}){const int flags=fcntl(fd,F_GETFL);Check(flags>=0&&fcntl(fd,F_SETFL,flags|O_NONBLOCK)==0,"nonblocking");}Check(out->client.Adopt(client)&&out->server.Adopt(server),"pair ownership");return out;
}
void Retry(SSL* ssl,int result){const int e=SSL_get_error(ssl,result);Check(e==SSL_ERROR_WANT_READ||e==SSL_ERROR_WANT_WRITE,"actual TLS WANT I/O");}
napi_value Run(napi_env env,napi_callback_info info){try{
 assertions=0;completedChecks.clear();size_t argc=3;napi_value argv[3];Check(napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr)==napi_ok&&argc==3,"cert/key/mode inputs");const auto certText=String(env,argv[0]),keyText=String(env,argv[1]),mode=String(env,argv[2]);
 auto pair=NewPair();const int original=pair->client.Fd(),port=pair->port;
 kandelo::socket::Owner tcp(70),peer(71);Check(tcp.Adopt(pair->client)&&peer.Adopt(pair->server),"actual TCP owner adoption");
 kandelo::tls::OwnedContext context(SSL_CTX_new(TLS_client_method())),serverContext(SSL_CTX_new(TLS_server_method()));Check(bool(context)&&bool(serverContext),"actual contexts");
 std::unique_ptr<BIO,decltype(&BIO_free)> cb(BIO_new_mem_buf(certText.data(),int(certText.size())),BIO_free),kb(BIO_new_mem_buf(keyText.data(),int(keyText.size())),BIO_free);
 std::unique_ptr<X509,decltype(&X509_free)> cert(PEM_read_bio_X509(cb.get(),nullptr,nullptr,nullptr),X509_free);std::unique_ptr<EVP_PKEY,decltype(&EVP_PKEY_free)> key(PEM_read_bio_PrivateKey(kb.get(),nullptr,nullptr,nullptr),EVP_PKEY_free);
 Check(bool(cert)&&bool(key)&&SSL_CTX_use_certificate(serverContext.get(),cert.get())==1&&SSL_CTX_use_PrivateKey(serverContext.get(),key.get())==1,"actual certificate/key");
 int contextFreed=0,sslFreed=0;const int ci=SSL_CTX_get_ex_new_index(0,nullptr,nullptr,nullptr,Freed),si=SSL_get_ex_new_index(0,nullptr,nullptr,nullptr,Freed);Check(ci>=0&&si>=0,"free callbacks");SSL_CTX_set_ex_data(context.get(),ci,&contextFreed);
 kandelo::tls::OwnedSSL clientSSL(SSL_new(context.get())),serverSSL(SSL_new(serverContext.get()));Check(bool(clientSSL)&&bool(serverSSL),"actual SSLs");SSL_set_ex_data(clientSSL.get(),si,&sslFreed);
 kandelo::tls::Owner owner(100,std::move(context),std::move(clientSSL));Check(owner.State()==kandelo::tls::Owner::Phase::Preparing,"preparing");
 kandelo::socket::Lease transfer;Check(tcp.StartRead(8),"actual queued read");Check(!tcp.TransferTo(transfer)&&tcp.Fd()==original&&transfer.Fd()<0,"active read refuses transfer");tcp.StopRead();Check(tcp.TransferTo(transfer)&&tcp.Fd()<0&&transfer.Fd()==original,"descriptor commit");Check(owner.Adopt(transfer)&&transfer.Fd()<0&&owner.Fd()==original,"TLS adopts original lease");Check(!owner.Adopt(transfer),"no double adoption");tcp.Close();Check(fcntl(owner.Fd(),F_GETFD)>=0,"source retirement cannot close recipient");
 Check(SSL_set_fd(owner.Ssl(),owner.Fd())==1&&SSL_set_fd(serverSSL.get(),peer.Fd())==1,"actual fd binding");SSL_set_connect_state(owner.Ssl());SSL_set_accept_state(serverSSL.get());
 const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);bool clientDone=false,serverDone=false;
 while(!clientDone||!serverDone){Check(std::chrono::steady_clock::now()<deadline,"handshake completion deadline");if(!clientDone){int n=SSL_connect(owner.Ssl());if(n==1)clientDone=true;else Retry(owner.Ssl(),n);}if(!serverDone){int n=SSL_accept(serverSSL.get());if(n==1)serverDone=true;else Retry(serverSSL.get(),n);}}
 Check(owner.AdmitHandshake()&&owner.Open()&&owner.Matches(100)&&!owner.Matches(99),"real handshake/generation admission");const std::string protocol=SSL_get_version(owner.Ssl()),cipher=SSL_CIPHER_get_name(SSL_get_current_cipher(owner.Ssl()));
 const std::string sent="original-owner-TLS-bytes";std::string got(sent.size(),0);size_t written=0,read=0;
 while(written<sent.size()||read<sent.size()){Check(std::chrono::steady_clock::now()<deadline,"plaintext completion deadline");if(written<sent.size()){int n=SSL_write(owner.Ssl(),sent.data()+written,int(sent.size()-written));if(n>0)written+=n;else Retry(owner.Ssl(),n);}if(read<sent.size()){int n=SSL_read(serverSSL.get(),got.data()+read,int(got.size()-read));if(n>0)read+=n;else Retry(serverSSL.get(),n);}}
 Check(got==sent,"real plaintext identity/count");

 auto readTicket=owner.BeginRead(64);Check(bool(readTicket)&&!readTicket->Complete(),"real read reservation");
 Check(!owner.ProgressRead(readTicket)&&!readTicket->Complete(),"control-only/no-data is not plaintext");
 owner.StopRead();const std::string incoming="guarded-real-plaintext";size_t peerWritten=0;
 while(peerWritten<incoming.size()){Check(std::chrono::steady_clock::now()<deadline,"server plaintext deadline");int n=SSL_write(serverSSL.get(),incoming.data()+peerWritten,int(incoming.size()-peerWritten));if(n>0)peerWritten+=n;else Retry(serverSSL.get(),n);}
 pollfd readiness={owner.Fd(),POLLIN,0};Check(poll(&readiness,1,1000)>0,"actual encrypted TCP readiness");Check(SSL_pending(owner.Ssl())==0,"encrypted readiness is not buffered plaintext");
 Check(!owner.ProgressRead(readTicket)&&!readTicket->Complete(),"stopped read does not consume");Check(owner.BeginRead(32)==readTicket,"resume preserves actual ticket");
 while(!owner.ProgressRead(readTicket)){Check(std::chrono::steady_clock::now()<deadline,"plaintext read completion");pollfd p={owner.Fd(),readTicket->events,0};poll(&p,1,10);}
 using Outcome=kandelo::tls::PlaintextRead::Outcome;using Delivery=kandelo::tls::PlaintextRead::Delivery;
 Check(readTicket->outcome==Outcome::Data&&readTicket->count==incoming.size(),"actual plaintext count");Check(std::string(reinterpret_cast<char*>(readTicket->bytes.data()),readTicket->count)==incoming,"actual plaintext bytes");
 owner.StopRead();Check(owner.BeginRead(64)==readTicket,"complete material retained through stop/restart");Check(owner.ReadMayProgress(readTicket),"actual completed material is ready");const auto* originalBytes=readTicket->bytes.data();
 Check(readTicket->BeginDelivery(),"begin actual publication");readTicket->AbortDelivery();Check(readTicket->delivery==Delivery::Queued&&readTicket->bytes.data()==originalBytes,"failed publication retains exact allocation");Check(readTicket->BeginDelivery(),"retry same result");readTicket->Published();Check(readTicket->delivery==Delivery::Published&&owner.CurrentRead()==readTicket,"published material retained until acknowledgement");
 Check(owner.AcknowledgeRead(readTicket)&&!owner.CurrentRead(),"acknowledge actual read");auto terminal=owner.BeginRead(64);Check(terminal!=readTicket&&!owner.AcknowledgeRead(readTicket),"stale acknowledgement cannot retire new read");
 if(mode=="abrupt") peer.Close();
 else if(mode=="reentry"){
  const char payload[]="retained-after-close";int n=SSL_write(serverSSL.get(),payload,sizeof(payload)-1);Check(n==int(sizeof(payload)-1),"second real plaintext write");
 }else Check(SSL_shutdown(serverSSL.get())>=0,"real peer close_notify");
 while(!owner.ProgressRead(terminal)){Check(std::chrono::steady_clock::now()<deadline,"terminal read completion");pollfd p={owner.Fd(),terminal->events,0};poll(&p,1,10);}
 std::string terminalKind;const int sslReadError=terminal->sslError,systemReadError=terminal->systemError;const auto opensslReadError=terminal->opensslError;
 if(mode=="abrupt"){Check(terminal->outcome==Outcome::Error&&terminal->sslError!=0,"abrupt TLS termination is an actual error, never clean EOF");terminalKind="error";}
 else if(mode=="reentry"){
  Check(terminal->outcome==Outcome::Data&&terminal->BeginDelivery(),"real second delivery");const auto bytes=std::string(reinterpret_cast<char*>(terminal->bytes.data()),terminal->count);owner.Close();
  Check(owner.Ssl()==nullptr&&!owner.CurrentRead()&&terminal->count==bytes.size(),"close detaches SSL but in-flight material survives");terminal->AbortDelivery();Check(terminal->BeginDelivery(),"retry material after close without SSL replay");terminal->Published();Check(std::string(reinterpret_cast<char*>(terminal->bytes.data()),terminal->count)==bytes,"retained bytes survive close/reentry");terminalKind="retained-data";
 }else{
  Check(terminal->outcome==Outcome::Eof&&terminal->count==0,"actual clean EOF");Check(terminal->BeginDelivery(),"EOF publication");terminal->Published();Check(owner.AcknowledgeRead(terminal),"EOF acknowledgement");auto again=owner.BeginRead(64);Check(again&&again->outcome==Outcome::Eof&&again->count==0,"actual cached EOF requires no extra SSL read");terminalKind="eof";
 }
 owner.Close();Check(!owner.Matches(100)&&owner.Fd()<0&&owner.Ssl()==nullptr,"closed authority retired");Check(contextFreed==1&&sslFreed==1,"actual context/SSL freed exactly once");Check(fcntl(original,F_GETFD)==-1&&errno==EBADF,"original fd closed");
 auto second=NewPair();if(second->client.Fd()!=original){Check(dup2(second->client.Fd(),original)==original,"actual same-number fd reuse");kandelo::socket::Lease reused(original);second->client.Close();Check(second->client.Adopt(reused),"reuse lease");}
 kandelo::socket::Owner tcp2(72);Check(tcp2.Adopt(second->client),"new actual TCP owner");kandelo::tls::OwnedContext context2(SSL_CTX_new(TLS_client_method()));kandelo::tls::OwnedSSL ssl2(SSL_new(context2.get()));kandelo::tls::Owner later(101,std::move(context2),std::move(ssl2));kandelo::socket::Lease transfer2;Check(tcp2.TransferTo(transfer2)&&later.Adopt(transfer2),"new TLS captured lease");Check(later.Fd()==original&&!later.Matches(100)&&later.Matches(101),"same fd distinct authority");owner.Close();Check(fcntl(later.Fd(),F_GETFD)>=0,"old close cannot close reused descriptor");later.Close();Check(contextFreed==1&&sslFreed==1,"old SSL/context no second free");
 napi_value out,v;Check(napi_create_object(env,&out)==napi_ok,"output");auto number=[&](const char* name,int value){napi_create_int32(env,value,&v);napi_set_named_property(env,out,name,v);};number("assertions",assertions);number("actualLoopbackPort",port);number("capturedAndReusedFd",original);number("plaintextBytes",int(read));number("contextFreeCallbacks",contextFreed);number("sslFreeCallbacks",sslFreed);number("sslReadError",sslReadError);number("systemReadError",systemReadError);number("opensslReadError",int(opensslReadError));napi_create_string_utf8(env,terminalKind.data(),terminalKind.size(),&v);napi_set_named_property(env,out,"terminalRead",v);napi_create_string_utf8(env,protocol.data(),protocol.size(),&v);napi_set_named_property(env,out,"protocol",v);napi_create_string_utf8(env,cipher.data(),cipher.size(),&v);napi_set_named_property(env,out,"cipher",v);
 napi_value checks;napi_create_array_with_length(env,completedChecks.size(),&checks);for(size_t i=0;i<completedChecks.size();++i){napi_create_string_utf8(env,completedChecks[i].data(),completedChecks[i].size(),&v);napi_set_element(env,checks,uint32_t(i),v);}napi_set_named_property(env,out,"completedChecks",checks);return out;
}catch(const std::exception& e){napi_throw_error(env,nullptr,e.what());return nullptr;}}
}
NAPI_MODULE_INIT(){napi_property_descriptor method={"run",nullptr,Run,nullptr,nullptr,nullptr,napi_default,nullptr};napi_define_properties(env,exports,1,&method);return exports;}
