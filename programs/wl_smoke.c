/*
 * wl_smoke — PR3 end-to-end proof that the wasm32 libwayland port works
 * against the kernel's Unix primitives. Runs one process that hosts BOTH a
 * libwayland *server* (wl_display + wl_event_loop) and a libwayland
 * *client* (wl_display_connect_to_fd), wired together over a kernel
 * AF_UNIX socketpair. Nothing here is mocked: real wl_marshal on the
 * client, real recvmsg + demarshal + wl_closure_invoke on the server.
 *
 * It proves the two integration risks the roadmap flags for PR3
 * (docs/plans/2026-07-08-dri-wayland-compositor-plan.md §4, §8):
 *
 *   [DISPATCH] wl_closure_invoke dispatches a real decoded request through
 *              the PR1 libffi shim. The client calls wl_compositor.create_surface
 *              (an object/new_id arg) then wl_surface.damage(7,11,100,200)
 *              (four int args). The server's implementation fires via
 *              wl_closure_invoke -> ffi_call -> the shim's arity switch
 *              (call_indirect). We assert the handlers ran AND that all four
 *              i32 words landed in the right parameter slots — end-to-end
 *              proof the shim marshals the full closure arg set correctly.
 *
 *   [PARK]     wl_event_loop's epoll_wait genuinely parks: with the socket
 *              drained, wl_event_loop_dispatch(loop, 60) blocks ~60 ms
 *              (kernel returns EAGAIN, host parks + retries) then returns 0.
 *   [WAKE]     with an unread client request pending, the same call returns
 *              promptly (client fd source is readable) instead of waiting
 *              out the timeout — epoll readiness drives the loop.
 *
 * Prints one line per checkpoint and "WL_SMOKE_OK" on success; exits
 * non-zero on any failure. host/test/libwayland-smoke.test.ts runs this
 * through the centralized kernel host and asserts the markers.
 */
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/socket.h>

#include <wayland-client.h>
#include <wayland-server.h>

/* ---- server-side implementations (invoked via wl_closure_invoke) ------ */

static int   g_create_surface_fired = 0;
static int   g_damage_fired = 0;
static int32_t g_dmg_x, g_dmg_y, g_dmg_w, g_dmg_h;

static void surface_destroy(struct wl_client *c, struct wl_resource *r) {}
static void surface_attach(struct wl_client *c, struct wl_resource *r,
                           struct wl_resource *buf, int32_t x, int32_t y) {}
static void surface_damage(struct wl_client *c, struct wl_resource *r,
                           int32_t x, int32_t y, int32_t w, int32_t h) {
    /* Four i32 words routed through the ffi shim's arity-6 case. */
    g_damage_fired = 1;
    g_dmg_x = x; g_dmg_y = y; g_dmg_w = w; g_dmg_h = h;
}
static void surface_frame(struct wl_client *c, struct wl_resource *r, uint32_t cb) {}
static void surface_set_opaque_region(struct wl_client *c, struct wl_resource *r,
                                      struct wl_resource *reg) {}
static void surface_set_input_region(struct wl_client *c, struct wl_resource *r,
                                     struct wl_resource *reg) {}
static void surface_commit(struct wl_client *c, struct wl_resource *r) {}
static void surface_set_buffer_transform(struct wl_client *c, struct wl_resource *r,
                                         int32_t t) {}
static void surface_set_buffer_scale(struct wl_client *c, struct wl_resource *r,
                                     int32_t s) {}
static void surface_damage_buffer(struct wl_client *c, struct wl_resource *r,
                                  int32_t x, int32_t y, int32_t w, int32_t h) {}
static void surface_offset(struct wl_client *c, struct wl_resource *r,
                           int32_t x, int32_t y) {}

static const struct wl_surface_interface surface_impl = {
    .destroy = surface_destroy,
    .attach = surface_attach,
    .damage = surface_damage,
    .frame = surface_frame,
    .set_opaque_region = surface_set_opaque_region,
    .set_input_region = surface_set_input_region,
    .commit = surface_commit,
    .set_buffer_transform = surface_set_buffer_transform,
    .set_buffer_scale = surface_set_buffer_scale,
    .damage_buffer = surface_damage_buffer,
    .offset = surface_offset,
};

static void compositor_create_surface(struct wl_client *client,
                                      struct wl_resource *resource, uint32_t id) {
    g_create_surface_fired = 1;
    struct wl_resource *s = wl_resource_create(
        client, &wl_surface_interface, wl_resource_get_version(resource), id);
    if (s)
        wl_resource_set_implementation(s, &surface_impl, NULL, NULL);
}
static void compositor_create_region(struct wl_client *client,
                                     struct wl_resource *resource, uint32_t id) {}

static const struct wl_compositor_interface compositor_impl = {
    .create_surface = compositor_create_surface,
    .create_region = compositor_create_region,
};

static void compositor_bind(struct wl_client *client, void *data,
                            uint32_t version, uint32_t id) {
    struct wl_resource *r =
        wl_resource_create(client, &wl_compositor_interface, version, id);
    if (r)
        wl_resource_set_implementation(r, &compositor_impl, NULL, NULL);
}

/* ---- client-side registry listener ------------------------------------ */

struct client_state {
    struct wl_registry  *registry;
    struct wl_compositor *compositor;
    uint32_t             compositor_name;
    uint32_t             compositor_version;
};

static void registry_global(void *data, struct wl_registry *registry,
                            uint32_t name, const char *interface,
                            uint32_t version) {
    struct client_state *cs = data;
    if (strcmp(interface, "wl_compositor") == 0) {
        cs->compositor_name = name;
        cs->compositor_version = version;
    }
}
static void registry_global_remove(void *data, struct wl_registry *r, uint32_t n) {}

static const struct wl_registry_listener registry_listener = {
    .global = registry_global,
    .global_remove = registry_global_remove,
};

/* ---- cooperative single-thread pump ----------------------------------- */

/* Non-blocking client read: flush our requests, then read+dispatch only
 * what is already on the socket (poll timeout 0). This is the canonical
 * wl_display_prepare_read/read_events pattern, made non-blocking so the
 * server and client can share one thread. */
static void client_pump(struct wl_display *c) {
    wl_display_flush(c);
    while (wl_display_prepare_read(c) != 0)
        wl_display_dispatch_pending(c);
    struct pollfd pfd = { .fd = wl_display_get_fd(c), .events = POLLIN };
    if (poll(&pfd, 1, 0) > 0 && (pfd.revents & POLLIN))
        wl_display_read_events(c);
    else
        wl_display_cancel_read(c);
    wl_display_dispatch_pending(c);
}

/* One full round: client -> server -> client. */
static void pump(struct wl_display *client, struct wl_display *server,
                 struct wl_event_loop *loop) {
    wl_display_flush(client);
    wl_event_loop_dispatch(loop, 0);      /* server reads + dispatches requests */
    wl_display_flush_clients(server);     /* server sends queued events */
    client_pump(client);                  /* client reads + dispatches events */
}

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

int main(void) {
    int sv[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) {
        fprintf(stderr, "socketpair: %s\n", strerror(errno));
        return 1;
    }

    /* --- server --- */
    struct wl_display *server = wl_display_create();
    if (!server) { fprintf(stderr, "wl_display_create failed\n"); return 1; }
    struct wl_event_loop *loop = wl_display_get_event_loop(server);
    if (!wl_global_create(server, &wl_compositor_interface, 5, NULL, compositor_bind)) {
        fprintf(stderr, "wl_global_create failed\n"); return 1;
    }
    if (!wl_client_create(server, sv[0])) {
        fprintf(stderr, "wl_client_create failed\n"); return 1;
    }
    printf("SERVER_UP\n");

    /* --- client --- */
    struct wl_display *client = wl_display_connect_to_fd(sv[1]);
    if (!client) { fprintf(stderr, "wl_display_connect_to_fd failed\n"); return 1; }
    struct client_state cs = {0};
    cs.registry = wl_display_get_registry(client);
    wl_registry_add_listener(cs.registry, &registry_listener, &cs);
    printf("CLIENT_UP\n");

    /* Discover + bind wl_compositor. */
    for (int i = 0; i < 50 && cs.compositor_name == 0; i++)
        pump(client, server, loop);
    if (cs.compositor_name == 0) {
        fprintf(stderr, "registry never advertised wl_compositor\n"); return 1;
    }
    cs.compositor = wl_registry_bind(cs.registry, cs.compositor_name,
                                     &wl_compositor_interface, cs.compositor_version);
    if (!cs.compositor) {
        fprintf(stderr, "bind failed (client_err=%d)\n", wl_display_get_error(client));
        return 1;
    }
    printf("BOUND_COMPOSITOR name=%u version=%u\n",
           cs.compositor_name, cs.compositor_version);

    /* [DISPATCH] client request -> server wl_closure_invoke -> ffi shim. */
    struct wl_surface *surface = wl_compositor_create_surface(cs.compositor);
    wl_surface_damage(surface, 7, 11, 100, 200);
    for (int i = 0; i < 50 && !g_damage_fired; i++)
        pump(client, server, loop);

    if (!g_create_surface_fired) {
        fprintf(stderr, "create_surface handler never fired\n"); return 1;
    }
    printf("DISPATCH_CREATE_SURFACE ok\n");
    if (!g_damage_fired) {
        fprintf(stderr, "damage handler never fired\n"); return 1;
    }
    if (g_dmg_x != 7 || g_dmg_y != 11 || g_dmg_w != 100 || g_dmg_h != 200) {
        fprintf(stderr, "damage args wrong: got (%d,%d,%d,%d) want (7,11,100,200)\n",
                g_dmg_x, g_dmg_y, g_dmg_w, g_dmg_h);
        return 1;
    }
    printf("DISPATCH_DAMAGE_ARGS ok x=%d y=%d w=%d h=%d\n",
           g_dmg_x, g_dmg_y, g_dmg_w, g_dmg_h);

    /* [PARK] socket fully drained -> epoll_wait must block ~timeout. */
    long t0 = now_ms();
    int r = wl_event_loop_dispatch(loop, 60);
    long parked = now_ms() - t0;
    printf("PARK dispatch_rc=%d elapsed_ms=%ld\n", r, parked);
    if (parked < 40) {
        fprintf(stderr, "epoll_wait did not park (elapsed %ld ms < 40)\n", parked);
        return 1;
    }

    /* [WAKE] queue an unread client request; the readable client-fd source
     * must wake the loop promptly rather than waiting out the 5 s timeout. */
    wl_surface_destroy(surface);
    wl_display_flush(client);
    long t1 = now_ms();
    wl_event_loop_dispatch(loop, 5000);
    long woke = now_ms() - t1;
    printf("WAKE elapsed_ms=%ld\n", woke);
    if (woke > 2000) {
        fprintf(stderr, "epoll_wait not woken by readable fd (elapsed %ld ms)\n", woke);
        return 1;
    }

    wl_display_disconnect(client);
    wl_display_destroy(server);
    printf("WL_SMOKE_OK\n");
    return 0;
}
