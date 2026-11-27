/*
 * kgpu-clear: the smallest complete kgpu client. It clears a 4x4 target to
 * (0.2, 0.4, 0.6, 1.0), reads it back and prints each pixel as
 * `pixel <i> <r> <g> <b> <a>`.
 *
 * WHY it exists: it proves the whole kgpu path end to end in a real host --
 * the `kandelo.kgpu.v1` program extension, the kernel's kgpu device (pins,
 * submits, waits), the host's GPU worker, the Rust executor and the
 * renderer -- with only the public interface a GL driver uses:
 * <kandelo/kgpu.h>, <kandelo/kgpu_stream.h> and `__kandelo_kgpu_v1`. No file
 * descriptor is opened (Ruling R9). apps/browser-demos/test/kgpu-clear.spec.ts
 * runs it in each browser engine.
 *
 * It exits 0 after printing all 16 pixels. Any failing call prints
 * `kgpu-clear: <call> failed: <result> <errno name>` and exits 1, so a host
 * that refuses kgpu (EOPNOTSUPP outside a memory group, ENODEV without a
 * renderer) is visible as that refusal rather than as wrong pixels.
 */
#include <errno.h>
#include <kandelo/kgpu.h>
#include <kandelo/kgpu_stream.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WIDTH 4
#define HEIGHT 4
#define PIXEL_BYTES (WIDTH * HEIGHT * 4)

static uint8_t stream[256] __attribute__((aligned(64)));
static size_t stream_len;

/* The import returns a negative errno and never sets errno, so the program
 * names it itself; the test matches the name. */
static const char *errno_name(int negative) {
  switch (-negative) {
  case EINVAL: return "EINVAL";
  case EFAULT: return "EFAULT";
  case ENODEV: return "ENODEV";
  case EOPNOTSUPP: return "EOPNOTSUPP";
  case ETIMEDOUT: return "ETIMEDOUT";
  case ETIME: return "ETIME";
  case EIO: return "EIO";
  case EAGAIN: return "EAGAIN";
  case ENOMEM: return "ENOMEM";
  case ENOSPC: return "ENOSPC";
  case EBADF: return "EBADF";
  case ESRCH: return "ESRCH";
  default: return "unknown";
  }
}

static int fail(const char *call, int result) {
  printf("kgpu-clear: %s failed: %d %s\n", call, result, errno_name(result));
  return 1;
}

static void record(uint16_t op, const void *payload, uint32_t len) {
  struct kgpu_record_header h = {.op = op, .flags = 0, .len = len};
  memcpy(stream + stream_len, &h, sizeof h);
  memcpy(stream + stream_len + sizeof h, payload, len);
  stream_len += sizeof h + len;
}

/* Viewport, clear color, clear and a readback into buffer 0. */
static void encode(uint32_t context) {
  stream_len = sizeof(struct kgpu_stream_header);
  struct kgpu_viewport viewport = {0, 0, WIDTH, HEIGHT};
  record(KGPU_OP_VIEWPORT, &viewport, sizeof viewport);
  struct kgpu_clear_color color = {0.2f, 0.4f, 0.6f, 1.0f};
  record(KGPU_OP_CLEAR_COLOR, &color, sizeof color);
  struct kgpu_clear clear = {KGPU_CLEAR_COLOR_BIT};
  record(KGPU_OP_CLEAR, &clear, sizeof clear);
  struct kgpu_read_pixels read = {0, 0, WIDTH, HEIGHT, 0};
  record(KGPU_OP_READ_PIXELS, &read, sizeof read);
  struct kgpu_stream_header header = {
      .magic = KGPU_STREAM_MAGIC,
      .version = KGPU_STREAM_VERSION,
      .reserved = 0,
      .context = context,
      .record_bytes = (uint32_t)(stream_len - sizeof header),
  };
  memcpy(stream, &header, sizeof header);
}

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);

  struct kgpu_context_create create = {0};
  int r = __kandelo_kgpu_v1(&create, sizeof create, KGPU_OP_CONTEXT_CREATE);
  if (r < 0) return fail("context create", r);

  uint8_t *pixels = malloc(PIXEL_BYTES);
  if (pixels == NULL) return fail("malloc", -ENOMEM);
  /* A sentinel the clear color cannot produce, so an unwritten buffer
   * cannot pass for a readback. */
  memset(pixels, 0xee, PIXEL_BYTES);
  struct kgpu_buffer buffer = {
      .addr = (uintptr_t)pixels, .len = PIXEL_BYTES, .access = KGPU_ACCESS_WRITE};

  encode(create.context);
  struct kgpu_submit submit = {
      .context = create.context,
      .stream_addr = (uintptr_t)stream,
      .stream_len = (uint32_t)stream_len,
      .buffer_count = 1,
      .buffers_addr = (uintptr_t)&buffer,
  };
  r = __kandelo_kgpu_v1(&submit, sizeof submit, KGPU_OP_SUBMIT);
  if (r < 0) return fail("submit", r);

  struct kgpu_wait wait = {.context = create.context, .seqno = submit.seqno, .timeout_ns = -1};
  r = __kandelo_kgpu_v1(&wait, sizeof wait, KGPU_OP_WAIT);
  if (r < 0) return fail("wait", r);

  for (int i = 0; i < WIDTH * HEIGHT; i++)
    printf("pixel %d %u %u %u %u\n", i, pixels[4 * i], pixels[4 * i + 1], pixels[4 * i + 2],
           pixels[4 * i + 3]);

  struct kgpu_context_destroy destroy = {.context = create.context};
  r = __kandelo_kgpu_v1(&destroy, sizeof destroy, KGPU_OP_CONTEXT_DESTROY);
  if (r < 0) return fail("context destroy", r);
  free(pixels);
  return 0;
}
