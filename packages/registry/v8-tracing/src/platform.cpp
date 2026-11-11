#include "src/base/platform/platform.h"
#include "src/base/platform/time.h"
#include "src/base/logging.h"
#include <cstdio>
#include <cstdlib>
#include <time.h>
#include <unistd.h>
namespace v8::base {
int OS::GetCurrentProcessId(){return getpid();}
int OS::GetCurrentThreadId(){return gettid();}
int OS::VSNPrintF(char* out,size_t capacity,const char* format,va_list args){return std::vsnprintf(out,capacity,format,args);}
void OS::VPrintError(const char* format,va_list args){std::vfprintf(stderr,format,args);}
void OS::PrintError(const char* format,...){va_list args;va_start(args,format);VPrintError(format,args);va_end(args);}
[[noreturn]] void OS::Abort(){std::abort();}
[[noreturn]] void OS::ExitProcess(int code){std::fflush(stdout);std::fflush(stderr);std::_Exit(code);}
static int64_t Micros(clockid_t id){timespec value{};CHECK_EQ(clock_gettime(id,&value),0);return int64_t(value.tv_sec)*1000000+value.tv_nsec/1000;}
TimeTicks TimeTicks::Now(){return TimeTicks(Micros(CLOCK_MONOTONIC));}
ThreadTicks ThreadTicks::Now(){return ThreadTicks(Micros(CLOCK_THREAD_CPUTIME_ID));}
}
