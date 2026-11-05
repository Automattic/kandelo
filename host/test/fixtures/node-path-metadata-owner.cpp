#include "path-metadata-operations.h"
#include <cstdio>
#include <cstdlib>
#include <string>
using namespace kandelo::nodefs;
static int Run(MetadataOperation operation, const std::string& path, MetadataOptions options = {}) {
  return RunMetadata(operation,path.c_str(),options);
}
static long long Mtime(const std::string& path, bool follow) {
  struct stat s{};
  if ((follow ? stat(path.c_str(),&s) : lstat(path.c_str(),&s)) != 0) std::abort();
#ifdef __APPLE__
  return s.st_mtimespec.tv_sec * 1000000000LL + s.st_mtimespec.tv_nsec;
#else
  return s.st_mtim.tv_sec * 1000000000LL + s.st_mtim.tv_nsec;
#endif
}
int main(int argc,char** argv) {
  if(argc!=2)return 2;
  const std::string root=argv[1],file=root+"/file",link=root+"/link",dangling=root+"/dangling",missing=root+"/missing";
  int fd=open(file.c_str(),O_CREAT|O_EXCL|O_WRONLY,0600);if(fd<0)return 3;
  if(write(fd,"actual",6)!=6 || close(fd)!=0 || symlink("file",link.c_str())!=0 || symlink("missing",dangling.c_str())!=0)return 4;
  MetadataOptions options;options.mode=F_OK;
  const int exists=Run(MetadataOperation::Access,file,options);
  options.mode=X_OK;const int noexec=Run(MetadataOperation::Access,file,options);
  options.mode=0640;const int changed=Run(MetadataOperation::Chmod,file,options);
  struct stat state{};if(stat(file.c_str(),&state)!=0)return 5;
  const auto mode=unsigned(state.st_mode & 07777);
  options.uid=getuid();options.gid=getgid();
  const int owner=Run(MetadataOperation::Chown,file,options);
  const int linkOwner=Run(MetadataOperation::Lchown,dangling,options);
  const int followMissing=Run(MetadataOperation::Chown,dangling,options);
  options.uid=uid_t(-1);options.gid=gid_t(-1);const int keepOwner=Run(MetadataOperation::Chown,file,options);
  options.times[0]={1000,125000000};options.times[1]={2000,250000000};
  const int time=Run(MetadataOperation::Utimes,link,options);
  const auto targetTime=Mtime(file,true);
  options.times[0]={3000,125000000};options.times[1]={4000,250000000};
  const int linkTime=Run(MetadataOperation::Lutimes,link,options);
  const auto finalTargetTime=Mtime(file,true),finalLinkTime=Mtime(link,false);
  printf("{\"exists\":%d,\"noexec\":%d,\"chmod\":%d,\"mode\":%u,\"chown\":%d,\"lchownDangling\":%d,\"chownDangling\":%d,\"keepOwner\":%d,\"utimes\":%d,\"lutimes\":%d,\"targetTime\":\"%lld\",\"finalTargetTime\":\"%lld\",\"linkTime\":\"%lld\",\"missing\":[",exists,noexec,changed,mode,owner,linkOwner,followMissing,keepOwner,time,linkTime,targetTime,finalTargetTime,finalLinkTime);
  bool first=true;
  options.mode=F_OK;
  for(const auto operation:{MetadataOperation::Access,MetadataOperation::Chmod,MetadataOperation::Chown,MetadataOperation::Lchown,MetadataOperation::Utimes,MetadataOperation::Lutimes}) {
    if(!first)putchar(',');
    first=false;
    printf("%d",Run(operation,missing,options));
  }
  puts("]}");
}
