#include "src/base/platform/platform.h"
#include "src/base/platform/time.h"
#include "src/base/logging.h"
#include <v8-platform.h>
#include "src/libplatform/default-job.h"
#include <v8-source-location.h>
#include <sstream>
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

namespace v8 {
// The embedder's epoch clock is the guest OS clock, distinct from the
// monotonic deadline clock used by Node/libuv task scheduling.
double Platform::SystemClockTimeMillis(){return double(base::Micros(CLOCK_REALTIME))/1000.0;}
}

namespace v8 {
// Complete portable SourceLocation method from pinned V8 api.cc. Its class
// remains the original v8-source-location.h value type, including loc_.
std::string SourceLocation::ToString() const {
  if (!*this) return {};
  return (std::ostringstream{} << loc_.function_name() << '@'
                               << loc_.file_name() << ':' << loc_.line())
      .str();
}
}

namespace v8::platform {
// Complete portable factory from pinned src/libplatform/default-platform.cc.
// Scheduling, joining and cancellation stay in original default-job.cc.
std::unique_ptr<JobHandle> NewDefaultJobHandle(
    Platform* platform, TaskPriority priority,
    std::unique_ptr<JobTask> job_task, size_t num_worker_threads) {
  return std::make_unique<DefaultJobHandle>(std::make_shared<DefaultJobState>(
      platform, std::move(job_task), priority, num_worker_threads));
}
}
