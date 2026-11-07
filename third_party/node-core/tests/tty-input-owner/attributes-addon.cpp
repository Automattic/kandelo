// Synchronous native reference observation; no event-loop turn between a
// target Node mode operation and the exact native tcgetattr result.
#include <node_api.h>
#include <fcntl.h>
#include <termios.h>
#include <unistd.h>
static napi_value Attributes(napi_env env,napi_callback_info info){
 size_t argc=1;napi_value argv[1];if(napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr)!=napi_ok||argc!=1)return nullptr;
 int32_t fd;if(napi_get_value_int32(env,argv[0],&fd)!=napi_ok)return nullptr;termios value{};
 if(tcgetattr(fd,&value)<0){napi_throw_error(env,nullptr,"actual tcgetattr failed");return nullptr;}
 napi_value result;if(napi_create_array_with_length(env,4,&result)!=napi_ok)return nullptr;
 const tcflag_t words[]={value.c_lflag,value.c_iflag,value.c_oflag,value.c_cflag};
 for(uint32_t i=0;i<4;++i){napi_value word;if(napi_create_double(env,double(words[i]),&word)!=napi_ok||napi_set_element(env,result,i,word)!=napi_ok)return nullptr;}
 return result;
}
static napi_value Duplicate(napi_env env,napi_callback_info info){
 size_t argc=1;napi_value argv[1];if(napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr)!=napi_ok||argc!=1)return nullptr;
 int32_t fd;if(napi_get_value_int32(env,argv[0],&fd)!=napi_ok)return nullptr;const int owned=fcntl(fd,F_DUPFD_CLOEXEC,3);
 if(owned<0){napi_throw_error(env,nullptr,"actual duplicate failed");return nullptr;}
 napi_value result;if(napi_create_int32(env,owned,&result)!=napi_ok){close(owned);return nullptr;}return result;
}
NAPI_MODULE_INIT(){napi_value attrs,dup;if(napi_create_function(env,"attributes",NAPI_AUTO_LENGTH,Attributes,nullptr,&attrs)!=napi_ok||napi_create_function(env,"duplicate",NAPI_AUTO_LENGTH,Duplicate,nullptr,&dup)!=napi_ok)return nullptr;if(napi_set_named_property(env,exports,"attributes",attrs)!=napi_ok||napi_set_named_property(env,exports,"duplicate",dup)!=napi_ok)return nullptr;return exports;}
