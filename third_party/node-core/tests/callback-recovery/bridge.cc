// Native component dependency: actual portable execution owner with N-API refs.
// Production uses SpiderMonkey PersistentRooted, not these refs. No guest claim.
#include <node_api.h>
#include "callback-execution-stack.h"
#include "native-retained-memory.h"
#include <new>
#include <stdexcept>
#include <vector>
#include <cmath>
using namespace kandelo;
static void Check(napi_status status){if(status!=napi_ok)throw std::runtime_error("NAPI fixture dependency failed");}
static napi_value Undefined(napi_env e){napi_value v;Check(napi_get_undefined(e,&v));return v;}
struct Ref {
 napi_env env;napi_ref ref=nullptr;
 Ref(napi_env e,napi_value value):env(e){napi_valuetype type;Check(napi_typeof(e,value,&type));if(type==napi_object||type==napi_function){bool isnull;Check(napi_strict_equals(e,value,Null(e),&isnull));if(!isnull)Check(napi_create_reference(e,value,1,&ref));}}
 static napi_value Null(napi_env e){napi_value v;Check(napi_get_null(e,&v));return v;}
 ~Ref(){if(ref)napi_delete_reference(env,ref);}
 napi_value Get()const{napi_value value;if(!ref)return Undefined(env);Check(napi_get_reference_value(env,ref,&value));return value;}
 Ref(const Ref&)=delete;Ref& operator=(const Ref&)=delete;
};
struct Payload {using Info=async::ExecutionStack<Payload>::Info;Ref prior,resource;memory::Allocation retained;memory::Claim claim;
 Payload(Info info,napi_env e,napi_value before,napi_value entering,const memory::AccountHandle& account):prior(e,before),resource(e,entering),retained(info.allocationBytes),claim(retained.Handle(),account){}
};
using Stack=async::ExecutionStack<Payload>;
struct State {napi_env env;std::unique_ptr<Ref> context;memory::AccountHandle account=std::make_shared<memory::Account>();Stack stack;double override=-1,counter=0;};
static napi_value Call(napi_env e,napi_callback_info info){
 size_t count=5;napi_value args[5];void* raw;Check(napi_get_cb_info(e,info,&count,args,nullptr,&raw));auto* pair=static_cast<std::pair<State*,int>*>(raw);auto& s=*pair->first;auto result=Undefined(e);
 auto number=[&](size_t i){double v;Check(napi_get_value_double(e,args[i],&v));return v;};
 auto numeric=[&](double v){napi_value n;Check(napi_create_double(e,v,&n));return n;};
 try{switch(pair->second){
 case 0:return s.context?s.context->Get():result;
 case 1:s.context=std::make_unique<Ref>(e,args[0]);return result;
 case 2:{bool native=false;if(count>3)Check(napi_get_value_bool(e,args[3],&native));s.stack.PushScope(number(0),number(1),native?Stack::Owner::NativeScope:Stack::Owner::JavaScriptScope,e,s.context?s.context->Get():result,args[2],s.account);return result;}
 case 3:{auto p=s.stack.Pop(number(0),[&](auto& entry){result=entry.prior.Get();});if(p==Stack::PopResult::WrongId)throw std::runtime_error("Stack ID mismatch");return result;}
 case 4:s.stack.Clear();s.context.reset();return result;
 case 5:return numeric(s.stack.Id());
 case 6:return numeric(s.stack.Trigger());
 case 7:Check(napi_get_boolean(e,!s.stack.Empty(),&result));return result;
 case 8:return s.stack.Top()?s.stack.Top()->resource.Get():result;
 case 9:return numeric(s.override>=0?s.override:s.stack.Id());
 case 10:{double value=number(0);if(!std::isfinite(value)||value< -1||value>9007199254740991.0||std::floor(value)!=value)throw std::runtime_error("Bad trigger");double prior=s.override;s.override=value;return numeric(prior);}
 case 11:return numeric(++s.counter);
 case 12:return numeric(s.account->Desired());
 default:throw std::runtime_error("Bad fixture method");
 }}catch(const std::exception& error){napi_throw_error(e,nullptr,error.what());return nullptr;}
}
struct Binding {State state;std::vector<std::pair<State*,int>> methods;};
static napi_value Init(napi_env e,napi_value exports){auto* b=new Binding;b->state.env=e;const char* names[]={"getAsyncContext","setAsyncContext","pushAsyncExecution","popAsyncExecution","clearAsyncExecution","executionAsyncId","triggerAsyncId","hasAsyncExecution","executionAsyncResource","getDefaultTriggerAsyncId","swapDefaultTriggerAsyncId","allocateAsyncId","retainedBytes"};b->methods.reserve(13);
 for(int i=0;i<13;++i){b->methods.emplace_back(&b->state,i);napi_value fn;Check(napi_create_function(e,names[i],NAPI_AUTO_LENGTH,Call,&b->methods.back(),&fn));Check(napi_set_named_property(e,exports,names[i],fn));}
 Check(napi_add_env_cleanup_hook(e,[](void* raw){delete static_cast<Binding*>(raw);},b));return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
