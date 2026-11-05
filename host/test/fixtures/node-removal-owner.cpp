#include "../../../third_party/node-core/removal-operations.h"
#include <iostream>
#include <stdexcept>
#include <climits>
static std::string Unhex(const char* arg) {
  std::string hex(arg), out;
  if (hex.size() % 2) throw std::runtime_error("odd hex input");
  for (size_t i = 0; i < hex.size(); i += 2) {
    size_t used; const auto byte = std::stoul(hex.substr(i, 2), &used, 16);
    if (used != 2 || !byte || byte > 255) throw std::runtime_error("invalid pathname byte");
    out.push_back(static_cast<char>(byte));
  }
  return out;
}
static void String(const std::string& value) {
  const char hex[]="0123456789abcdef";std::cout << '"';
  for (unsigned char c : value) {
    if(c>=32 && c<127 && c!='"' && c!='\\') std::cout << c;
    else std::cout << "\\u00" << hex[c>>4] << hex[c&15];
  }
  std::cout << '"';
}
int main(int argc,char** argv) {
  try {
    if(argc<3)throw std::runtime_error("operation/path required");
    const auto path=Unhex(argv[2]);
    if(std::string(argv[1])=="scan") {
      const auto result=kandelo::nodefs::ScanDirectory(path.c_str());
      std::cout << "{\"status\":" << result.status << ",\"names\":[";
      const char hex[]="0123456789abcdef";
      for(size_t i=0;i<result.names.size();++i){if(i)std::cout<<',';std::cout<<'"';for(unsigned char c:result.names[i])std::cout<<hex[c>>4]<<hex[c&15];std::cout<<'"';}
      std::cout << "]}\n"; return 0;
    }
    if(argc!=6)throw std::runtime_error("rm path retries recursive delay required");
    const auto raw=std::stoll(argv[3]);
    if(raw<0 || raw>UINT32_MAX)throw std::runtime_error("retry range");
    const auto retries=static_cast<int32_t>(raw<=INT32_MAX?raw:raw-0x100000000LL);
    const auto result=kandelo::nodefs::RemoveSync(path,retries,std::string(argv[4])=="true",std::stoi(argv[5]));
    if(!result.error && !result.unknown) {std::cout<<"null\n";return 0;}
    std::cout << '[' << result.error << ',' << (result.directory?"true":"false") << ',' << (result.unknown?"true":"false") << ',';
    String(result.message);std::cout<<',';String(path);std::cout<<"]\n";return 0;
  } catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
