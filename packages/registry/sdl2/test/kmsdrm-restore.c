#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#define DRM_DISPLAY_MODE_LEN 32
#define DRM_MODE_TYPE_PREFERRED (1u<<3)
#define drm_public
#define memclear(x) memset(&(x),0,sizeof(x))
#define VOID2U64(p) ((uint64_t)(uintptr_t)(p))
#define DRM_IOCTL_MODE_GETCRTC 0xc06864a1u
#define DRM_IOCTL_MODE_SETCRTC 0xc06864a2u
#define DRM_IOCTL(fd,request,arg) drmIoctl(fd,request,arg)
#define SDL_memcmp memcmp
#define SDL_SetError(s) (-1)
#define SDL_LOG_CATEGORY_VIDEO 0
#include "mode-type.inc"
#include "crtc-type.inc"
typedef uint32_t __u32;typedef uint16_t __u16;typedef uint64_t __u64;
#include "uapi-types.inc"
_Static_assert(sizeof(struct drm_mode_crtc)==104,"exact UAPI header size");
_Static_assert(offsetof(struct drm_mode_crtc,mode_valid)==32,"exact UAPI validity offset");
_Static_assert(offsetof(struct drm_mode_crtc,mode)==36,"exact UAPI mode offset");
struct Connector {uint32_t connector_id;int count_modes;drmModeModeInfo *modes;};
struct Display {drmModeModeInfo mode,original_mode,fullscreen_mode;drmModeCrtcPtr crtc;struct Connector *connector;};
struct Video {int drm_fd;};
static struct drm_mode_crtc current;
static struct drm_mode_crtc calls[4];static unsigned call_count,logs;static int inject_errno;
static int drmIoctl(int fd,uint32_t request,struct drm_mode_crtc *p){
 (void)fd;
 if(request==DRM_IOCTL_MODE_GETCRTC){if(p->crtc_id!=1){errno=ENOENT;return -1;}*p=current;return 0;}
 if(request!=DRM_IOCTL_MODE_SETCRTC||call_count>=4)abort();calls[call_count++]=*p;
 /* Explicit ioctl boundary double: it validates only the input shapes this
  * source-causal control needs. This is not Linux or Kandelo execution. */
 if(p->mode_valid&&p->fb_id==0){errno=ENOENT;return -1;}
 if((p->mode_valid!=0)!=(p->count_connectors!=0)){errno=EINVAL;return -1;}
 if(inject_errno){errno=inject_errno;return -1;}
 current=*p;return 0;
}
static void *drmMalloc(size_t n){return calloc(1,n);}
#include "libdrm-get.inc"
#include "libdrm-set.inc"
#define KMSDRM_drmModeSetCrtc drmModeSetCrtc
static void SDL_LogError(int category,const char *s){(void)category;if(strcmp(s,"Could not restore CRTC"))abort();logs++;fprintf(stderr,"SDL_LogError: %s\n",s);}
static int select_mode(struct Display *dispdata,struct Connector *connector,drmModeCrtcPtr crtc){int mode_index,i,ret=0;
#include "sdl-selection.inc"
cleanup:return ret;
}
static int restore(struct Video *viddata,struct Display *dispdata){int ret;
#include "sdl-restore.inc"
 return ret;
}
#define CHECK(x) do{if(!(x)){fprintf(stderr,"FAIL %s:%d: %s\n",__FILE__,__LINE__,#x);return 1;}}while(0)
int main(int argc,char **argv){
 if(argc!=2)return 2;
 const int lit=!strcmp(argv[1],"lit")||!strcmp(argv[1],"lit-failure");
 const int failing=!strcmp(argv[1],"dark-failure")||!strcmp(argv[1],"lit-failure");
 if(!lit&&!failing&&strcmp(argv[1],"dark"))return 2;
 drmModeModeInfo preferred={.clock=28980,.hdisplay=640,.hsync_start=728,.hsync_end=772,.htotal=920,.vdisplay=480,.vsync_start=484,.vsync_end=489,.vtotal=525,.vrefresh=60,.type=DRM_MODE_TYPE_PREFERRED};
 struct Connector connector={.connector_id=3,.count_modes=1,.modes=&preferred};struct Video video={.drm_fd=3};
 current=(struct drm_mode_crtc){.crtc_id=1,.fb_id=lit?55:0,.mode_valid=(unsigned)lit};if(lit)memcpy(&current.mode,&preferred,sizeof preferred);
 drmModeCrtcPtr saved=drmModeGetCrtc(3,1);CHECK(saved);CHECK(saved->mode_valid==lit);CHECK(saved->buffer_id==(lit?55u:0u));
 struct Display display={.crtc=saved,.connector=&connector};CHECK(select_mode(&display,&connector,saved)==0);CHECK(display.original_mode.hdisplay==640);CHECK(saved->mode_valid==lit);CHECK(saved->buffer_id==(lit?55u:0u));
 const struct drm_mode_crtc before=current;inject_errno=failing?EACCES:0;errno=0;
 int ret=restore(&video,&display),result_errno=errno;
 printf("{\"case\":\"%s\",\"savedFb\":%u,\"savedModeValid\":%d,\"defaultModeWidth\":%u,\"calls\":%u,\"wireFb\":%u,\"wireModeValid\":%u,\"wireModeWidth\":%u,\"wireConnectors\":%u,\"wirePointerIsNull\":%s,\"internalRet\":%d,\"errno\":%d,\"errorLogs\":%u}\n",argv[1],saved->buffer_id,saved->mode_valid,display.original_mode.hdisplay,call_count,calls[0].fb_id,calls[0].mode_valid,calls[0].mode.hdisplay,calls[0].count_connectors,calls[0].set_connectors_ptr?"false":"true",ret,result_errno,logs);
 /* Test the restoration contract, independently of how SDL implements it.
  * The original dark path must fail this same control; no expected-result
  * switch or candidate implementation is embedded in the assertion. */
 if(call_count!=1||calls[0].crtc_id!=1||calls[0].fb_id!=(lit?55u:0u)||calls[0].mode_valid!=(unsigned)lit||calls[0].count_connectors!=(unsigned)lit){fprintf(stderr,"FAIL restoration shape/call count\n");free(saved);return 41;}
 if(lit){CHECK(calls[0].set_connectors_ptr!=0);CHECK(*(uint32_t *)(uintptr_t)calls[0].set_connectors_ptr==3);CHECK(!memcmp(&calls[0].mode,&preferred,sizeof preferred));}
 else{CHECK(calls[0].set_connectors_ptr==0);CHECK(!memcmp(&calls[0].mode,&(struct drm_mode_modeinfo){0},sizeof calls[0].mode));}
 CHECK(ret==(failing?-1:0));CHECK(logs==(unsigned)failing);
 if(failing){CHECK(result_errno==EACCES);CHECK(!memcmp(&current,&before,sizeof before));}
 else{CHECK(result_errno==0);CHECK(current.fb_id==(lit?55u:0u));CHECK(current.mode_valid==(unsigned)lit);}
 CHECK(saved->mode_valid==lit);CHECK(saved->buffer_id==(lit?55u:0u));CHECK(display.original_mode.hdisplay==640);
 free(saved);return 0;
}
