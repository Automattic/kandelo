#include "os-operations.h"
#include <cstdio>
#include <cstdlib>
#include <string>
using namespace kandelo::node_os;
static void Bytes(const std::string& value) {
  std::putchar('"'); for (unsigned char c : value) std::printf("%02x",unsigned(c)); std::putchar('"');
}
int main(int argc,char** argv) {
  if (argc < 2) return 2;
  const std::string name = argv[1];
  int error = 0;
  std::printf("{\"error\":");
  if (name == "info") {
    const auto result = Information(); std::printf("%d,\"value\":[",result.error);
    for (size_t i=0;i<4;i++) { if (i) std::putchar(','); Bytes(result.value[i]); }
    std::putchar(']');
  } else if (name == "home" || name == "hostname") {
    const auto result = name == "home" ? HomeDirectory() : Hostname();
    std::printf("%d,\"value\":",result.error); Bytes(result.value);
  } else if (name == "temp") {
    const auto value = TemporaryDirectory(); std::printf("0,\"value\":");
    if (value) Bytes(*value); else std::printf("null");
  } else if (name == "user") {
    const auto result=UserInfo(); const auto& user=result.value;
    std::printf("%d,\"value\":{\"uid\":%llu,\"gid\":%llu,\"username\":",result.error,
      (unsigned long long)user.uid,(unsigned long long)user.gid); Bytes(user.username);
    std::printf(",\"homedir\":"); Bytes(user.homedir); std::printf(",\"shell\":"); Bytes(user.shell); std::putchar('}');
  } else if (name == "getpriority") {
    const auto result=GetPriority(argc > 2 ? std::atoi(argv[2]) : 0); std::printf("%d,\"value\":%d",result.error,result.value);
  } else if (name == "setpriority") {
    if (argc < 4) return 3;
    error=SetPriority(std::atoi(argv[2]),std::atoi(argv[3])); std::printf("%d",error);
  } else if (name == "endianness") {
    std::printf("0,\"value\":%s",IsBigEndian() ? "true" : "false");
  } else return 4;
  std::printf("}\n");
  return 0;
}
