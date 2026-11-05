#include "../../../third_party/node-core/package-config.h"
#include <cstdio>
#include <fstream>
#include <iterator>
static std::string Hex(const std::string& input){const char* digits="0123456789abcdef";std::string out;for(unsigned char byte:input){out+=digits[byte>>4];out+=digits[byte&15];}return out;}
static void Text(const std::optional<std::string>& text){if(text)std::printf("\"%s\"",Hex(*text).c_str());else std::printf("null");}
static void Print(const kandelo::packages::Result& result){
 std::printf("{\"kind\":%d,\"error\":%d,\"errorPath\":\"%s\",\"values\":",result.invalid?2:result.error?3:result.config?0:1,result.error,Hex(result.errorPath).c_str());
 if(!result.config){std::printf("null}");return;}const auto& c=*result.config;std::printf("[");Text(c.name);std::printf(",");Text(c.main);std::printf(",\"%s\",",Hex(c.type).c_str());Text(c.imports);std::printf(",");Text(c.exports);std::printf(",\"%s\"]}",Hex(c.file_path).c_str());
}
int main(int argc,char** argv){if(argc<3)return 2;try{kandelo::packages::Cache cache;const bool nearest=!std::strcmp(argv[1],"nearest");auto first=nearest?cache.Nearest(argv[2]):cache.Get(argv[2]);if(argc==3){Print(first);std::puts("");return 0;}
 std::printf("[");Print(first);std::printf(",");std::ifstream source(argv[3],std::ios::binary);std::string replacement((std::istreambuf_iterator<char>(source)),{});{std::ofstream out(argv[2],std::ios::binary);out<<replacement;}
 Print(cache.Get(argv[2]));std::puts("]");return 0;}catch(const std::exception& error){std::fprintf(stderr,"%s\n",error.what());return 1;}}
