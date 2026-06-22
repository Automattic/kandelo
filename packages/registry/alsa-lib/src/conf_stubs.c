/*
 * alsa-lib subset — link-time stubs for the configuration/output/async
 * surface that the PCM-hardware-direct subset does NOT compile in.
 *
 * The patched src/pcm/pcm.c (0001-default-to-hw00.patch) bypasses the
 * snd_config_* path in snd_pcm_open_noupdate(), but pcm.c's surrounding
 * code (snd_pcm_open, snd_pcm_dump, snd_pcm_status_dump, …),
 * control.c, and others still reference snd_config_*, snd_output_*,
 * and snd_async_* symbols at link time. Provide ENOSYS/no-op
 * implementations so the static link succeeds. Any code path that
 * actually invokes one of these returns -ENOSYS / NULL / 0 — but the
 * subset's runtime path (snd_pcm_open("default" or "hw:N,M") →
 * snd_pcm_hw_open) is patched to never reach them.
 *
 * Two exceptions to the ENOSYS pattern:
 *   - snd_config_update_ref() returns 0 and writes a non-NULL sentinel
 *     pointer so that snd_pcm_open()'s `err = snd_config_update_ref(&top)`
 *     succeeds, the patched snd_pcm_open_noupdate() ignores its `root`
 *     argument, and the subsequent snd_config_unref(top) becomes a
 *     no-op release of the sentinel.
 *   - snd_config_unref() is a no-op (it would otherwise need to free
 *     the sentinel returned above).
 */

#include "local.h"
#include "conf.h"
#include "output.h"
#include "global.h"
#include <errno.h>
#include <stddef.h>

/* Sentinel for snd_config_update_ref's `*top` out-param. The patched
 * snd_pcm_open_noupdate ignores its `root` argument; the only
 * requirement is that this value be non-NULL and survive a subsequent
 * snd_config_unref() (which is a no-op below). `struct _snd_config`
 * is opaque in the public header — we never dereference the sentinel,
 * so a single byte suffices and we cast through `void *`. */
static char _wpk_conf_sentinel;

int snd_config_update_ref(snd_config_t **top)
{
	if (top)
		*top = (snd_config_t *) (void *) &_wpk_conf_sentinel;
	return 0;
}

void snd_config_unref(snd_config_t *top)
{
	(void) top;
}

/* All other snd_config_* entry points return -ENOSYS or a similar
 * "nothing here" signal. The subset never calls these at runtime. */

int snd_config_search(snd_config_t *config, const char *key,
		      snd_config_t **result)
{
	(void) config; (void) key; (void) result;
	return -ENOENT;
}

int snd_config_search_definition(snd_config_t *config,
				 const char *base, const char *key,
				 snd_config_t **result)
{
	(void) config; (void) base; (void) key; (void) result;
	return -ENOENT;
}

int snd_config_delete(snd_config_t *config)
{
	(void) config;
	return 0;
}

int snd_config_copy(snd_config_t **dst, snd_config_t *src)
{
	(void) dst; (void) src;
	return -ENOSYS;
}

snd_config_type_t snd_config_get_type(const snd_config_t *config)
{
	(void) config;
	return SND_CONFIG_TYPE_INTEGER;
}

int snd_config_is_array(const snd_config_t *config)
{
	(void) config;
	return 0;
}

int snd_config_get_id(const snd_config_t *config, const char **value)
{
	(void) config;
	if (value) *value = NULL;
	return -ENOENT;
}

int snd_config_get_integer(const snd_config_t *config, long *value)
{
	(void) config;
	if (value) *value = 0;
	return -ENOENT;
}

int snd_config_get_string(const snd_config_t *config, const char **value)
{
	(void) config;
	if (value) *value = NULL;
	return -ENOENT;
}

int snd_config_get_ascii(const snd_config_t *config, char **value)
{
	(void) config;
	if (value) *value = NULL;
	return -ENOENT;
}

int snd_config_get_bool(const snd_config_t *conf)
{
	(void) conf;
	return -ENOENT;
}

int snd_config_get_card(const snd_config_t *conf)
{
	(void) conf;
	return -ENOENT;
}

int snd_config_get_ctl_iface_ascii(const char *ascii)
{
	(void) ascii;
	return -ENOENT;
}

snd_config_iterator_t snd_config_iterator_first(const snd_config_t *node)
{
	(void) node;
	return NULL;
}

snd_config_iterator_t snd_config_iterator_next(const snd_config_iterator_t iterator)
{
	(void) iterator;
	return NULL;
}

snd_config_iterator_t snd_config_iterator_end(const snd_config_t *node)
{
	(void) node;
	return NULL;
}

snd_config_t *snd_config_iterator_entry(const snd_config_iterator_t iterator)
{
	(void) iterator;
	return NULL;
}

/* Recursion-guard helpers used by snd_pcm_open_conf / snd_ctl_open_conf
 * (both elided from this subset). The patched open path never calls
 * these. */
void snd_config_set_hop(snd_config_t *conf, int hop)
{
	(void) conf; (void) hop;
}

int snd_config_check_hop(snd_config_t *conf)
{
	(void) conf;
	return 0;
}

/* snd_output_* — used by snd_pcm_dump / snd_ctl_dump for diagnostics.
 * The subset doesn't build snd_output (output.c) so provide minimal
 * stubs. snd_pcm_dump etc still compile and link; calling them yields
 * empty output. */
int snd_output_stdio_attach(snd_output_t **outputp, FILE *fp, int _close)
{
	(void) fp; (void) _close;
	if (outputp) *outputp = NULL;
	return -ENOSYS;
}

int snd_output_close(snd_output_t *output)
{
	(void) output;
	return 0;
}

int snd_output_printf(snd_output_t *output, const char *format, ...)
{
	(void) output; (void) format;
	return 0;
}

int snd_output_puts(snd_output_t *output, const char *str)
{
	(void) output; (void) str;
	return 0;
}

int snd_output_putc(snd_output_t *output, int c)
{
	(void) output; (void) c;
	return 0;
}

/* snd_async_* — POSIX SIGIO-driven async dispatch. The kernel does not
 * deliver SIGIO; consumers that try to register async handlers receive
 * -ENOSYS and degrade to polling. */
int snd_async_add_handler(snd_async_handler_t **handler, int fd,
			  snd_async_callback_t callback, void *private_data)
{
	(void) fd; (void) callback; (void) private_data;
	if (handler) *handler = NULL;
	return -ENOSYS;
}

int snd_async_del_handler(snd_async_handler_t *handler)
{
	(void) handler;
	return -ENOSYS;
}

int snd_async_handler_get_signo(snd_async_handler_t *handler)
{
	(void) handler;
	return -ENOSYS;
}

/* snd_device_name_* — alsa-lib's namehint API. Used by SDL2's ALSA
 * audio backend during SDL_Init(SDL_INIT_AUDIO) to enumerate available
 * PCM devices. Our PCM-hardware-direct subset advertises exactly one
 * device ("default" → /dev/snd/pcmC0D0p); the namehint enumeration
 * surface adds nothing on top of that. Return an empty hint list so
 * SDL2's enumeration loop iterates zero times and falls through to
 * its hard-coded "default" path.
 *
 * Contract per upstream alsa-lib:
 *   snd_device_name_hint(card, iface, void ***hints):
 *     On success, *hints is a NULL-terminated array of opaque hint
 *     pointers. The caller iterates until *hints[i] == NULL, then
 *     frees via snd_device_name_free_hint. An empty list (one-element
 *     array containing only NULL) means "no hints — no devices".
 */
static void *_wpk_namehint_empty[1] = { NULL };

int snd_device_name_hint(int card, const char *iface, void ***hints)
{
	(void) card;
	(void) iface;
	if (hints)
		*hints = _wpk_namehint_empty;
	return 0;
}

int snd_device_name_free_hint(void **hints)
{
	(void) hints;
	return 0;
}

char *snd_device_name_get_hint(const void *hint, const char *id)
{
	(void) hint;
	(void) id;
	return NULL;
}

/* page_align / page_size / page_ptr — defined in conf.c, used by
 * src/pcm/pcm_hw.c's mmap fallback path (map_status_data /
 * map_control_data) and by pcm_mmap.c. conf.c isn't compiled in this
 * subset, so reimplement them as plain integer arithmetic. The kernel
 * exposes wasm linear-memory pages of 65536 bytes; libc reports
 * sysconf(_SC_PAGE_SIZE) = 4096 for compatibility (the alsa SYNC_PTR
 * fallback only needs *some* alignment, not the actual host page). */
#include <stddef.h>
size_t page_size(void)
{
	return 4096;
}

size_t page_align(size_t size)
{
	size_t psz = page_size();
	size_t r = size % psz;
	if (r)
		return size + psz - r;
	return size;
}

size_t page_ptr(size_t object_offset, size_t object_size, size_t *offset, size_t *mmap_offset)
{
	size_t psz = page_size();
	size_t r;
	if (mmap_offset) *mmap_offset = object_offset;
	r = object_offset % psz;
	if (mmap_offset) *mmap_offset -= r;
	object_offset = r;
	object_size += object_offset;
	r = object_size % psz;
	if (r)
		r = object_size + psz - r;
	else
		r = object_size;
	if (offset) *offset = object_offset;
	return r;
}
