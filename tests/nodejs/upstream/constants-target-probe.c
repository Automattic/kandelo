/* Independent target-header oracle and real guest POSIX effects. */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <dlfcn.h>
#include <openssl/opensslv.h>
#include <openssl/ssl.h>
#include <uv.h>
#include <zlib.h>
#include <zstd.h>
#include <zstd_errors.h>
#define VALUE(group, name) printf("%s\"%s.%s\":%.0f", entries++?",":"", group, #name, (double)(name))
#define REQUIRE(test) do { if(!(test)){fprintf(stderr,"target probe failed line%d: %s errno%d\n",__LINE__,#test,errno);return 1;} } while(0)
int main(void) {
  int entries=0;printf("{\"kind\":\"native-constants-target-probe\",\"values\":{");
  VALUE("os.errno",EAGAIN);VALUE("os.errno",ENOENT);VALUE("os.errno",EINVAL);VALUE("os.errno",ENOSYS);VALUE("os.errno",ECANCELED);
  VALUE("os.signals",SIGINT);VALUE("os.signals",SIGTERM);VALUE("os.signals",SIGUSR1);VALUE("os.signals",SIGCHLD);VALUE("os.signals",SIGABRT);VALUE("os.signals",SIGKILL);
  VALUE("os.dlopen",RTLD_LAZY);VALUE("os.dlopen",RTLD_NOW);VALUE("os.dlopen",RTLD_GLOBAL);VALUE("os.dlopen",RTLD_LOCAL);
  VALUE("fs",O_RDONLY);VALUE("fs",O_WRONLY);VALUE("fs",O_RDWR);VALUE("fs",O_CREAT);VALUE("fs",O_TRUNC);VALUE("fs",O_APPEND);VALUE("fs",O_DIRECTORY);VALUE("fs",O_NONBLOCK);VALUE("fs",O_SYNC);VALUE("fs",O_DSYNC);
  VALUE("fs",S_IFMT);VALUE("fs",S_IFREG);VALUE("fs",S_IFDIR);VALUE("fs",S_IRUSR);VALUE("fs",S_IWUSR);VALUE("fs",F_OK);VALUE("fs",R_OK);VALUE("fs",W_OK);VALUE("fs",X_OK);
  VALUE("os",UV_UDP_REUSEADDR);VALUE("crypto",OPENSSL_VERSION_NUMBER);VALUE("crypto",TLS1_2_VERSION);VALUE("crypto",SSL_OP_NO_TLSv1_3);
  VALUE("zlib",ZLIB_VERNUM);VALUE("zlib",Z_FINISH);VALUE("zlib",Z_DEFAULT_COMPRESSION);VALUE("zlib",ZSTD_CLEVEL_DEFAULT);VALUE("zlib",ZSTD_error_noForwardProgress_inputEmpty);
  printf("},\"effects\":[");
  const char* path="/tmp/target-constants-effect";struct stat s;
  int fd=open(path,O_CREAT|O_EXCL|O_WRONLY,0600);REQUIRE(fd>=0);REQUIRE(write(fd,"a",1)==1);REQUIRE(fstat(fd,&s)==0);REQUIRE((s.st_mode&S_IFMT)==S_IFREG);REQUIRE(close(fd)==0);
  fd=open(path,O_APPEND|O_WRONLY);REQUIRE(fd>=0);REQUIRE(write(fd,"b",1)==1);REQUIRE(close(fd)==0);fd=open(path,O_RDONLY);REQUIRE(fd>=0);char content[3]={0};REQUIRE(read(fd,content,2)==2);REQUIRE(strcmp(content,"ab")==0);REQUIRE(close(fd)==0);
  errno=0;REQUIRE(open(path,O_CREAT|O_EXCL|O_WRONLY,0600)==-1);REQUIRE(errno==EEXIST);REQUIRE(unlink(path)==0);errno=0;REQUIRE(open(path,O_RDONLY)==-1);REQUIRE(errno==ENOENT);
  printf("\"create-write-mode\",\"append-read\",\"exclusive-EEXIST\",\"unlink-ENOENT\"]}\n");return 0;
}
