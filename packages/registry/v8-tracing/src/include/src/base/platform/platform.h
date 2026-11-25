#pragma once
#include <cstdarg>
#include <cstddef>
#include <sstream>
#include "src/base/logging.h"
#include "src/base/macros.h"
namespace v8::base {
class OS {
 public: static int GetCurrentProcessId();static int GetCurrentThreadId();
 static int VSNPrintF(char*,size_t,const char*,va_list);
 static void PrintError(const char*,...);static void VPrintError(const char*,va_list);
 [[noreturn]] static void Abort();
 [[noreturn]] static void ExitProcess(int);
};
}
