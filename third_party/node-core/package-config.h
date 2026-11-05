// Actual POSIX package file/cache ownership. Parsing is the pinned native policy.
#ifndef KANDELO_NODE_PACKAGE_CONFIG_H
#define KANDELO_NODE_PACKAGE_CONFIG_H
#include <algorithm>
#include <cerrno>
#include <climits>
#include <cstdint>
#include <fcntl.h>
#include <filesystem>
#include <limits>
#include <optional>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <unordered_map>

#include "kandelo-node-package-parser.h"
namespace kandelo::packages {
inline int ReadFile(const std::string& path, std::string* output) {
  int fd; do { fd=::open(path.c_str(),O_RDONLY|O_CLOEXEC); } while(fd<0&&errno==EINTR);
  if(fd<0)return -errno;
  struct Owner {int fd;~Owner(){if(fd>=0)::close(fd);}} owner{fd};
  struct stat info;int status;
  do{status=::fstat(fd,&info);}while(status<0&&errno==EINTR);
  if(status<0)return -errno;
  if(info.st_size<0||uint64_t(info.st_size)>SIZE_MAX)return -EFBIG;
  size_t size=info.st_size?size_t(info.st_size):8192,read=0;
  output->resize(size);
  for(;;){
    const size_t remaining=std::min(size-read,size_t(INT_MAX));ssize_t count;
    do{count=::read(fd,output->data()+read,remaining);}while(count<0&&errno==EINTR);
    if(count<0)return -errno;if(count==0)break;
    read+=size_t(count);
    if(read==size){if(size==SIZE_MAX)return -EFBIG;size=size>SIZE_MAX/2?SIZE_MAX:size*2;output->resize(size);}
  }
  owner.fd=-1;status=::close(fd);
  if(status<0&&errno!=EINTR&&errno!=EINPROGRESS)return -errno;
  output->resize(read);return 0;
}
struct Result {const PackageConfig* config=nullptr;int error=0;bool invalid=false;std::string errorPath;};
class Cache {
  Parser parser_;
  std::unordered_map<std::string,std::optional<PackageConfig>> configs_;
 public:
  Result Get(const std::string& path) {
    auto found=configs_.find(path);
    if(found!=configs_.end())return {found->second?&*found->second:nullptr,0,false,{}};
    PackageConfig config;config.file_path=path;
    const int status=ReadFile(path,&config.raw_json);
    if(status<0){
      if(status==-ENOENT||status==-ENOTDIR||status==-EISDIR){configs_.emplace(path,std::nullopt);return {};}
      return {nullptr,status,false,path};
    }
    if(!parser_.Parse(&config))return {nullptr,0,true,path};
    auto stored=configs_.emplace(path,std::move(config));return {&*stored.first->second,0,false,{}};
  }
  Result Nearest(const std::string& checkPath) {
    // POSIX std::filesystem traversal is the pinned native parent policy:
    // trailing separators retain directory context, root and node_modules stop.
    std::filesystem::path current(checkPath);
    for(;;){current=current.parent_path();
      if(current.parent_path()==current||current.filename()=="node_modules")return {};
      auto result=Get((current/"package.json").string());
      if(result.config||result.invalid||result.error)return result;
    }
  }
  size_t AccountedBytes() const {
    size_t total=sizeof(*this);
    for(const auto& item:configs_){
      total+=sizeof(item)+item.first.capacity()+1;
      if(item.second){const auto& c=*item.second;total+=c.file_path.capacity()+c.type.capacity()+c.raw_json.capacity()+3;
        for(const auto* s:{&c.name,&c.main,&c.exports,&c.imports,&c.scripts})if(*s)total+=(**s).capacity()+1;}
    }
    return total;
  }
};
}  // namespace kandelo::packages
#endif
