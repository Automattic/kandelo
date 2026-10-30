/* Included only after the pinned upstream wayland-client.c. Public connection
 * entry points are renamed in that TU; all protocol/transport code stays
 * upstream. Private proxy access here retains actual native storage, rather
 * than trying to identify an arbitrary native pointer by dereferencing it. */
#undef wl_display_connect
#undef wl_display_connect_to_fd
#undef wl_display_disconnect
#include "wayland-native.h"
#include <limits.h>

struct wpk_wl_connection {
    struct wl_display *display;
    uint64_t identity;
    unsigned users;
    int alive;
    struct wpk_wl_connection *next;
};
struct wpk_wl_surface {
    struct wpk_wl_connection *connection;
    struct wl_proxy *proxy;
};
static pthread_mutex_t wpk_wl_mutex=PTHREAD_MUTEX_INITIALIZER;
static struct wpk_wl_connection *wpk_wl_connections;
static uint64_t wpk_wl_serial;
static struct wpk_wl_connection *wpk_wl_find(const void *native) {
    for(struct wpk_wl_connection *p=wpk_wl_connections;p;p=p->next)
        if(p->display==native)return p;
    return NULL;
}
static struct wl_display *wpk_wl_register(struct wl_display *display) {
    if(!display)return NULL;
    struct wpk_wl_connection *record=calloc(1,sizeof *record);
    pthread_mutex_lock(&wpk_wl_mutex);
    if(!record || wpk_wl_serial==UINT64_MAX) {
        pthread_mutex_unlock(&wpk_wl_mutex);free(record);
        _wpk_upstream_display_disconnect(display);errno=ENOMEM;return NULL;
    }
    *record=(struct wpk_wl_connection){.display=display,.identity=++wpk_wl_serial,
        .alive=1,.next=wpk_wl_connections};
    wpk_wl_connections=record;
    pthread_mutex_unlock(&wpk_wl_mutex);return display;
}
WL_EXPORT struct wl_display *wl_display_connect(const char *name) {
    return wpk_wl_register(_wpk_upstream_display_connect(name));
}
WL_EXPORT struct wl_display *wl_display_connect_to_fd(int fd) {
    return wpk_wl_register(_wpk_upstream_display_connect_to_fd(fd));
}
/* Returns actual cleanup custody after unlinking, with no lock held while
 * upstream releases queues/proxies/connection storage. */
static struct wpk_wl_connection *wpk_wl_collect(struct wpk_wl_connection *record) {
    if(record->alive || record->users)return NULL;
    struct wpk_wl_connection **p=&wpk_wl_connections;
    while(*p && *p!=record)p=&(*p)->next;
    if(*p)*p=record->next;
    return record;
}
static void wpk_wl_free(struct wpk_wl_connection *record) {
    if(record) {_wpk_upstream_display_disconnect(record->display);free(record);}
}
WL_EXPORT void wl_display_disconnect(struct wl_display *display) {
    pthread_mutex_lock(&wpk_wl_mutex);
    struct wpk_wl_connection *record=wpk_wl_find(display),*retired=NULL;
    if(record && record->alive) {
        record->alive=0;
        if(record->users)shutdown(display->fd,SHUT_RDWR);
        retired=wpk_wl_collect(record);
    }
    pthread_mutex_unlock(&wpk_wl_mutex);wpk_wl_free(retired);
}
int _wpk_wl_display_metadata(const void *native,uint64_t *identity) {
    pthread_mutex_lock(&wpk_wl_mutex);
    struct wpk_wl_connection *record=wpk_wl_find(native);
    int found=record && record->alive;
    if(found)*identity=record->identity;
    pthread_mutex_unlock(&wpk_wl_mutex);return found;
}
void *_wpk_wl_display_acquire(const void *native,uint64_t identity) {
    pthread_mutex_lock(&wpk_wl_mutex);
    struct wpk_wl_connection *record=wpk_wl_find(native);
    if(!record || !record->alive || record->identity!=identity || record->users==UINT_MAX)record=NULL;
    else record->users++;
    pthread_mutex_unlock(&wpk_wl_mutex);return record;
}
int _wpk_wl_display_alive(void *lease) {
    pthread_mutex_lock(&wpk_wl_mutex);
    int alive=((struct wpk_wl_connection *)lease)->alive;
    pthread_mutex_unlock(&wpk_wl_mutex);return alive;
}
void _wpk_wl_display_release(void *lease) {
    struct wpk_wl_connection *record=lease;
    if(!record)return;
    pthread_mutex_lock(&wpk_wl_mutex);record->users--;
    struct wpk_wl_connection *retired=wpk_wl_collect(record);
    pthread_mutex_unlock(&wpk_wl_mutex);wpk_wl_free(retired);
}
struct wpk_wl_lookup {const void *native;struct wl_proxy *found;};
static enum wl_iterator_result wpk_wl_find_surface(void *element,void *data,uint32_t flags) {
    struct wpk_wl_lookup *lookup=data;
    if(!(flags & WL_MAP_ENTRY_ZOMBIE) && element==lookup->native) {
        struct wl_proxy *proxy=element;
        if(proxy->object.interface==&wl_surface_interface && !(proxy->flags & WL_PROXY_FLAG_DESTROYED))lookup->found=proxy;
    }
    return WL_ITERATOR_CONTINUE;
}
void *_wpk_wl_surface_acquire(const void *native,const void **display,uint64_t *identity) {
    if(!native)return NULL;
    struct wpk_wl_surface *hold=calloc(1,sizeof *hold);
    if(!hold)return NULL;
    pthread_mutex_lock(&wpk_wl_mutex);
    for(struct wpk_wl_connection *p=wpk_wl_connections;p;p=p->next)if(p->alive && p->users<UINT_MAX) {
        struct wpk_wl_lookup lookup={.native=native};
        pthread_mutex_lock(&p->display->mutex);
        wl_map_for_each(&p->display->objects,wpk_wl_find_surface,&lookup);
        if(lookup.found && lookup.found->refcount<INT_MAX) {
            lookup.found->refcount++;p->users++;
            *hold=(struct wpk_wl_surface){.connection=p,.proxy=lookup.found};
            *display=p->display;*identity=p->identity;
        }
        pthread_mutex_unlock(&p->display->mutex);
        if(hold->proxy)break;
    }
    pthread_mutex_unlock(&wpk_wl_mutex);
    if(!hold->proxy) {free(hold);return NULL;}
    return hold;
}
static int wpk_wl_surface_lock(struct wpk_wl_surface *hold) {
    pthread_mutex_lock(&wpk_wl_mutex);
    struct wl_display *display=hold->connection->display;
    pthread_mutex_lock(&display->mutex);
    int alive=hold->connection->alive && !(hold->proxy->flags & WL_PROXY_FLAG_DESTROYED) && !display->last_error;
    pthread_mutex_unlock(&wpk_wl_mutex);
    if(!alive)pthread_mutex_unlock(&display->mutex);
    return alive;
}
int _wpk_wl_surface_alive(void *lease) {
    struct wpk_wl_surface *hold=lease;
    if(!wpk_wl_surface_lock(hold))return 0;
    pthread_mutex_unlock(&hold->connection->display->mutex);return 1;
}
/* Use upstream's exact closure/connection machinery while its display lock
 * serializes wl_surface destruction. No check-then-marshal race or wrapper
 * pretending to own the original proxy. */
static int wpk_wl_request(struct wl_proxy *proxy,uint32_t opcode,union wl_argument *args) {
    const struct wl_message *message=&proxy->object.interface->methods[opcode];
    struct wl_closure *closure=wl_closure_marshal(&proxy->object,opcode,args,message);
    if(!closure) {display_fatal_error(proxy->display,errno);return 0;}
    int ok=wl_closure_send(closure,proxy->display->connection)==0;
    if(!ok)display_fatal_error(proxy->display,errno);
    wl_closure_destroy(closure);return ok;
}
int _wpk_wl_surface_present(void *lease,void *buffer,int width,int height) {
    struct wpk_wl_surface *hold=lease;
    if(!wpk_wl_surface_lock(hold))return 0;
    union wl_argument attach[]={{.o=buffer},{.i=0},{.i=0}};
    union wl_argument damage[]={{.i=0},{.i=0},{.i=width},{.i=height}};
    int ok=wpk_wl_request(hold->proxy,WL_SURFACE_ATTACH,attach)
        && wpk_wl_request(hold->proxy,WL_SURFACE_DAMAGE,damage)
        && wpk_wl_request(hold->proxy,WL_SURFACE_COMMIT,NULL);
    pthread_mutex_unlock(&hold->connection->display->mutex);return ok;
}
void _wpk_wl_surface_release(void *lease) {
    struct wpk_wl_surface *hold=lease;
    if(!hold)return;
    struct wpk_wl_connection *record=hold->connection;
    pthread_mutex_lock(&record->display->mutex);
    wl_proxy_unref(hold->proxy);
    pthread_mutex_unlock(&record->display->mutex);
    free(hold);_wpk_wl_display_release(record);
}
