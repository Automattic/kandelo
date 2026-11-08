// Real TCP/OpenSSL/native owner control. No production JSAPI is executed.
#include <node_api.h>
#include "tls-owner.h"
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <cstring>
#include <chrono>
using kandelo::socket::Lease;
static void Check(bool value,const char*message){if(!value)throw std::runtime_error(message);}
struct Pair {
 kandelo::socket::Owner tcp{81};Lease peer;
 std::unique_ptr<kandelo::tls::Owner> tls;
 Pair(){
  Lease listenFd(socket(AF_INET,SOCK_STREAM,0));Check(listenFd.Fd()>=0,"listener");
  sockaddr_in addr={};addr.sin_family=AF_INET;addr.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  Check(bind(listenFd.Fd(),reinterpret_cast<sockaddr*>(&addr),sizeof(addr))==0&&listen(listenFd.Fd(),1)==0,"bind/listen");
  socklen_t len=sizeof(addr);Check(getsockname(listenFd.Fd(),reinterpret_cast<sockaddr*>(&addr),&len)==0,"address");
  Lease client(socket(AF_INET,SOCK_STREAM,0));Check(client.Fd()>=0&&connect(client.Fd(),reinterpret_cast<sockaddr*>(&addr),len)==0,"connect");
  Lease accepted(accept(listenFd.Fd(),nullptr,nullptr));Check(accepted.Fd()>=0&&peer.Adopt(accepted),"accept");
  for(int fd:{client.Fd(),peer.Fd()})Check(fcntl(fd,F_SETFL,fcntl(fd,F_GETFL)|O_NONBLOCK)==0,"nonblocking");
  Check(tcp.Adopt(client),"TCP actual lease");
  kandelo::tls::OwnedContext context(SSL_CTX_new(TLS_method()));Check(bool(context),"context");
  kandelo::tls::OwnedSSL ssl(SSL_new(context.get()));Check(bool(ssl),"SSL");
  tls=std::make_unique<kandelo::tls::Owner>(92,std::move(context),std::move(ssl));
  Check(tls->AttachParent(tcp)&&tls->BindParent(),"split output BIO/captured parent");
 }
 ~Pair(){if(tls)tls->Close(false);}
 std::string Read(size_t count){std::string out;char buf[4096];for(int i=0;i<10000&&out.size()<count;++i){ssize_t n=recv(peer.Fd(),buf,sizeof(buf),0);if(n>0)out.append(buf,size_t(n));else if(n<0&&errno!=EAGAIN&&errno!=EWOULDBLOCK&&errno!=EINTR)throw std::runtime_error("peer read");else{pollfd wait={peer.Fd(),POLLIN,0};poll(&wait,1,50);}}Check(out.size()==count,"exact peer bytes");return out;}
};
struct Span{std::vector<uint8_t>bytes{1,'X'};void*Data()const{return const_cast<uint8_t*>(bytes.data());}size_t Length()const{return bytes.size();}};
struct Foreign: kandelo::socket::TransportAttachment{void ParentClosed()noexcept override{}bool HasRequests()const noexcept override{return false;}};
static std::string PathArg(napi_env env,napi_value value){size_t n;Check(napi_get_value_string_utf8(env,value,nullptr,0,&n)==napi_ok,"path length");std::vector<char>bytes(n+1);Check(napi_get_value_string_utf8(env,value,bytes.data(),bytes.size(),&n)==napi_ok,"path bytes");return std::string(bytes.data(),n);}
static void Want(SSL*ssl,int result,const char*operation){const int error=SSL_get_error(ssl,result);if(error!=SSL_ERROR_WANT_READ&&error!=SSL_ERROR_WANT_WRITE){char text[256];ERR_error_string_n(ERR_get_error(),text,sizeof(text));throw std::runtime_error(std::string(operation)+":"+text);}}

struct Ticket {
 size_t& count;bool live=true;
 explicit Ticket(size_t& count):count(count){++count;}
 void Complete(){if(live){Check(count>0,"actual callback ticket");--count;live=false;}}
 ~Ticket(){Complete();}
};
struct Operation final:kandelo::tls::ShutdownOperation {
 size_t& writes;
 Operation(kandelo::tls::Owner& owner,size_t& writes):ShutdownOperation(owner),writes(writes){allocation.Resize(sizeof(Operation));}
 bool HasEarlierWrites()const noexcept override{return writes!=0;}
};
static napi_value Run(napi_env env,napi_callback_info info){try{
 size_t argc=4;napi_value argv[4];Check(napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr)==napi_ok&&argc==4,"version/key/cert/mode");int32_t version;Check(napi_get_value_int32(env,argv[0],&version)==napi_ok,"version");const auto key=PathArg(env,argv[1]),cert=PathArg(env,argv[2]),mode=PathArg(env,argv[3]);
 Pair p;auto& owner=*p.tls;auto*client=owner.Ssl();Check(SSL_set_min_proto_version(client,version)==1&&SSL_set_max_proto_version(client,version)==1,"client version");
 kandelo::tls::OwnedContext context(SSL_CTX_new(TLS_method()));Check(bool(context),"server context");Check(SSL_CTX_set_min_proto_version(context.get(),version)==1&&SSL_CTX_set_max_proto_version(context.get(),version)==1,"server version");Check(SSL_CTX_use_certificate_file(context.get(),cert.c_str(),SSL_FILETYPE_PEM)==1&&SSL_CTX_use_PrivateKey_file(context.get(),key.c_str(),SSL_FILETYPE_PEM)==1,"real credentials");kandelo::tls::OwnedSSL server(SSL_new(context.get()));Check(bool(server)&&SSL_set_fd(server.get(),p.peer.Fd())==1,"server SSL");
 auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(4);auto time=[&]{Check(std::chrono::steady_clock::now()<deadline,"actual protocol deadline");};
 bool connected=false,accepted=false;ERR_clear_error();
 while(!connected||!accepted||owner.EncryptedPending()){
  time();owner.ProgressEncrypted(owner.EncryptedNeedsAcknowledgment());Check(owner.EncryptedError()==0,"handshake ciphertext");
  if(!connected&&!owner.EncryptedPending()){int n=SSL_connect(client);if(n==1){connected=true;Check(owner.AdmitHandshake(),"handshake admission");}else Want(client,n,"connect");owner.ProgressEncrypted(false);}
  if(!accepted){int n=SSL_accept(server.get());if(n==1)accepted=true;else Want(server.get(),n,"accept");}
 }
 size_t callbacks=0;Ticket earlier(callbacks);const std::string bytes(8192,'D');std::string received;bool written=false;
 while(!written||owner.EncryptedPending()||received.size()<bytes.size()){
  time();owner.ProgressEncrypted(owner.EncryptedNeedsAcknowledgment());Check(owner.EncryptedError()==0,"data ciphertext");
  if(!written&&!owner.EncryptedPending()){int n=SSL_write(client,bytes.data(),int(bytes.size()));if(n>0){Check(size_t(n)==bytes.size(),"write count");written=true;}else Want(client,n,"write");owner.ProgressEncrypted(false);}
  char buf[8192];int n=SSL_read(server.get(),buf,sizeof(buf));if(n>0)received.append(buf,size_t(n));else Want(server.get(),n,"read");
 }
 Check(received==bytes,"actual earlier application bytes");
 Foreign foreign;kandelo::socket::Shutdown denied(p.tcp.Generation()),raw(p.tcp.Generation());
 Check(p.tcp.QueueShutdown(raw)==EBUSY&&p.tcp.QueueTransportShutdown(denied,foreign)==EBUSY,"raw and foreign shutdown stay denied");
 kandelo::socket::Shutdown shutdown(p.tcp.Generation());auto operation=std::make_unique<Operation>(owner,callbacks);Check(owner.HasRequests()&&p.tcp.HasTransportRequests(),"real request holds close barrier");
 Check(p.tcp.QueueTransportShutdown(shutdown,owner)==0,"actual attached transport authorized");
 Check(!operation->Progress(shutdown,false)&&!operation->Flight().attempted&&(SSL_get_shutdown(client)&SSL_SENT_SHUTDOWN)==0,"earlier callback prevents close_notify");earlier.Complete();Check(callbacks==0,"callback ticket retired");
 bool canceled=false,fatal=false,sawReceipt=false,queuePreserved=false;unsigned long queueBefore=0,queueAfter=0;
 if(mode=="fatal"){
  p.peer.Close();auto read=owner.BeginRead(32);while(!owner.ProgressRead(read)){time();}Check(read->outcome==kandelo::tls::PlaintextRead::Outcome::Error,"real fatal SSL read");
  Check(operation->Progress(shutdown,false)&&operation->Flight().failed&&!operation->Flight().attempted&&shutdown.complete,"fatal read prevents actual SSL_shutdown");fatal=true;
  // Never run the old invalid abrupt-after-fatal SSL_shutdown fixture.
  owner.Close(false);p.tcp.Close();
 }else{
  if(mode.find("-clean")!=std::string::npos)ERR_clear_error();else ERR_raise(ERR_LIB_USER,99);const auto previous=ERR_peek_error();queueBefore=previous;
  const bool progressed = operation->Progress(shutdown,false);
  if (progressed || !operation->Flight().attempted || operation->Flight().localComplete || !owner.EncryptedPending()) {
    const auto& flight=operation->Flight();
    throw std::runtime_error("real alert output waits receipt acknowledgement: progress="+std::to_string(progressed)+" attempted="+std::to_string(flight.attempted)+" complete="+std::to_string(flight.localComplete)+" pending="+std::to_string(owner.EncryptedPending())+" first="+std::to_string(flight.firstResult)+" second="+std::to_string(flight.secondResult)+" sslflags="+std::to_string(SSL_get_shutdown(client))+" failed="+std::to_string(flight.failed)+" error="+std::to_string(flight.systemError));
  }
  queueAfter=ERR_peek_error();Check(queueAfter==previous,"marked error queue preserved");queuePreserved=true;ERR_clear_error();sawReceipt=owner.EncryptedNeedsAcknowledgment();Check(sawReceipt,"actual captured alert receipt");
  if(mode.rfind("cancel",0)==0){
   const int old=p.tcp.Fd();p.tcp.Close();Check(owner.State()==kandelo::tls::Owner::Phase::Closed,"actual parent close invalidates SSL");Check(owner.HasRequests()&&p.tcp.HasTransportRequests(),"cancel retains request through callback");
   Check(operation->Progress(shutdown,false)&&shutdown.complete&&shutdown.error==ECANCELED&&!operation->Flight().localComplete,"cancel is not successful flush");
   int reused=open("/dev/null",O_RDONLY);Check(reused>=0,"reuse open");if(reused!=old){Check(dup2(reused,old)==old,"actual fd reuse");close(reused);reused=old;}operation.reset();owner.Close(false);p.tcp.Close();Check(fcntl(reused,F_GETFD)>=0,"old close cannot retire reused descriptor");close(reused);canceled=true;
  }else{
   while(!operation->Progress(shutdown,false)){time();}Check(operation->Flight().localComplete&&!operation->Flight().failed&&!owner.EncryptedPending(),"local output actually acknowledged");
   Check((SSL_get_shutdown(client)&SSL_RECEIVED_SHUTDOWN)==0,"does not wait for peer close_notify");Check(p.tcp.ProgressShutdown(shutdown,false)&&shutdown.complete&&shutdown.error==0,"real parent half-close after alert receipt");
   char data[32];int n;do{time();n=SSL_read(server.get(),data,sizeof(data));if(n<0){const int e=SSL_get_error(server.get(),n);Check(e==SSL_ERROR_WANT_READ||e==SSL_ERROR_WANT_WRITE,"peer read WANT");}}while(n<0);Check(n==0&&SSL_get_error(server.get(),n)==SSL_ERROR_ZERO_RETURN,"peer observes authenticated close_notify");
   ssize_t end;do{time();end=recv(p.peer.Fd(),data,sizeof(data),0);if(end<0)Check(errno==EAGAIN||errno==EWOULDBLOCK||errno==EINTR,"peer raw FIN readiness");}while(end<0);Check(end==0,"peer observes actual TCP FIN");
   Check(!p.tcp.Closed()&&owner.Open()&&owner.HasRequests(),"shutdown callback still owns live read-side transport");
  }
 }
 const bool attempted=operation?operation->Flight().attempted:true;operation.reset();Check(!owner.HasRequests()&&!p.tcp.HasTransportRequests(),"actual request retires after callback boundary");owner.Close(false);p.tcp.Close();
 napi_value out,v;Check(napi_create_object(env,&out)==napi_ok,"output");auto flag=[&](const char*n,bool x){napi_get_boolean(env,x,&v);napi_set_named_property(env,out,n,v);};flag("passed",true);flag("actualEarlierBytesMatch",received==bytes);flag("actualAlertReceipt",sawReceipt);flag("queuePreserved",queuePreserved);flag("canceledNotFlushed",canceled);flag("fatalRefusedBeforeShutdown",fatal);flag("attempted",attempted);napi_create_double(env,double(queueBefore),&v);napi_set_named_property(env,out,"queueBefore",v);napi_create_double(env,double(queueAfter),&v);napi_set_named_property(env,out,"queueAfter",v);napi_create_string_utf8(env,mode.c_str(),NAPI_AUTO_LENGTH,&v);napi_set_named_property(env,out,"mode",v);napi_create_int32(env,version,&v);napi_set_named_property(env,out,"version",v);return out;
 }catch(const std::exception&e){napi_throw_error(env,nullptr,e.what());return nullptr;}}
static napi_value ErrorQueue(napi_env env,napi_callback_info info){size_t argc=1;napi_value argv[1],out;napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);const auto mode=PathArg(env,argv[0]);if(mode=="push")ERR_raise(ERR_LIB_USER,99);else if(mode=="clear")ERR_clear_error();napi_create_double(env,double(ERR_peek_error()),&out);return out;}
static napi_value Init(napi_env env,napi_value exports){napi_value f;napi_create_function(env,"run",NAPI_AUTO_LENGTH,Run,nullptr,&f);napi_set_named_property(env,exports,"run",f);napi_create_function(env,"errorQueue",NAPI_AUTO_LENGTH,ErrorQueue,nullptr,&f);napi_set_named_property(env,exports,"errorQueue",f);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
