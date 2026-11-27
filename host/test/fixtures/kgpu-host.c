/*
 * Guest side of host/test/kgpu-host.test.ts: drive kandelo.kgpu.v1 through
 * the real process worker, kernel device, kernel-worker GPU host and GPU
 * worker, using only <kandelo/kgpu.h> and <kandelo/kgpu_stream.h> as a GL
 * driver would. Each step prints one line the test reads.
 *
 * argv[1] selects the scenario:
 *   clear     clear a context to (0.2, 0.4, 0.6, 1.0), read back 4x4 pixels
 *   many N    N large submissions (64 buffers each), then wait each in order
 *   exit      submit a readback and exit at once, without waiting
 *   wait      submit a readback and wait for it with no timeout
 *   fault     submit a stream whose context field names another context
 *   create    only create a context
 *   lose      keep the first context idle, submit a readback on a second
 *             and wait for it (the renderer is lost meanwhile); after the
 *             test's stdin go-ahead, submit on the idle context and create
 */
#include <kandelo/kgpu.h>
#include <kandelo/kgpu_stream.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* The stream's bytes, 64-byte aligned so a short stream sits in one page. */
static uint8_t stream[256] __attribute__((aligned(64)));
static size_t stream_len;
static uint8_t pixels[64] __attribute__((aligned(64)));
static struct kgpu_buffer buffers[KGPU_MAX_BUFFERS];

static void record(uint16_t op, const void *payload, uint32_t len) {
  struct kgpu_record_header h = {.op = op, .flags = 0, .len = len};
  memcpy(stream + stream_len, &h, sizeof h);
  memcpy(stream + stream_len + sizeof h, payload, len);
  stream_len += sizeof h + len;
}

static void begin(void) {
  stream_len = sizeof(struct kgpu_stream_header);
}

static void finish(uint32_t context) {
  struct kgpu_stream_header h = {
      .magic = KGPU_STREAM_MAGIC,
      .version = KGPU_STREAM_VERSION,
      .reserved = 0,
      .context = context,
      .record_bytes = (uint32_t)(stream_len - sizeof h),
  };
  memcpy(stream, &h, sizeof h);
}

/* Viewport, clear color, clear and (with `readback`) a 4x4 RGBA readback
 * into buffer 0. */
static void clear_stream(uint32_t context, int readback) {
  begin();
  struct kgpu_viewport v = {0, 0, 4, 4};
  record(KGPU_OP_VIEWPORT, &v, sizeof v);
  struct kgpu_clear_color c = {0.2f, 0.4f, 0.6f, 1.0f};
  record(KGPU_OP_CLEAR_COLOR, &c, sizeof c);
  struct kgpu_clear m = {KGPU_CLEAR_COLOR_BIT};
  record(KGPU_OP_CLEAR, &m, sizeof m);
  if (readback) {
    struct kgpu_read_pixels r = {0, 0, 4, 4, 0};
    record(KGPU_OP_READ_PIXELS, &r, sizeof r);
  }
  finish(context);
}

static int create(uint32_t *context) {
  struct kgpu_context_create c = {0};
  int r = __kandelo_kgpu_v1(&c, sizeof c, KGPU_OP_CONTEXT_CREATE);
  *context = c.context;
  return r;
}

static int submit(uint32_t context, uint32_t buffer_count, uint64_t *seqno) {
  struct kgpu_submit s = {
      .context = context,
      .stream_addr = (uintptr_t)stream,
      .stream_len = (uint32_t)stream_len,
      .buffer_count = buffer_count,
      .buffers_addr = (uintptr_t)buffers,
  };
  int r = __kandelo_kgpu_v1(&s, sizeof s, KGPU_OP_SUBMIT);
  *seqno = s.seqno;
  return r;
}

static int wait_for(uint32_t context, uint64_t seqno) {
  struct kgpu_wait w = {.context = context, .seqno = seqno, .timeout_ns = -1};
  return __kandelo_kgpu_v1(&w, sizeof w, KGPU_OP_WAIT);
}

static void readback_buffer(void) {
  buffers[0] = (struct kgpu_buffer){
      .addr = (uintptr_t)pixels, .len = sizeof pixels, .access = KGPU_ACCESS_WRITE};
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  if (argc < 2) return 2;
  const char *mode = argv[1];
  uint32_t context = 0;
  int r = create(&context);
  printf("create %d %u\n", r, context);
  if (r != 0 || strcmp(mode, "create") == 0) return r == 0 ? 0 : 1;
  uint64_t seqno = 0;

  if (strcmp(mode, "clear") == 0 || strcmp(mode, "wait") == 0) {
    memset(pixels, 0xee, sizeof pixels);
    readback_buffer();
    clear_stream(context, 1);
    r = submit(context, 1, &seqno);
    printf("submit %d %llu\n", r, (unsigned long long)seqno);
    if (r != 0) return 1;
    r = wait_for(context, seqno);
    printf("wait %d\n", r);
    if (r != 0) return strcmp(mode, "wait") == 0 ? 0 : 1;
    for (int i = 0; i < 16; i++)
      printf("pixel %d %u %u %u %u\n", i, pixels[4 * i], pixels[4 * i + 1], pixels[4 * i + 2],
             pixels[4 * i + 3]);
    return 0;
  }

  if (strcmp(mode, "exit") == 0) {
    readback_buffer();
    clear_stream(context, 1);
    r = submit(context, 1, &seqno);
    printf("submit %d %llu\n", r, (unsigned long long)seqno);
    return r == 0 ? 0 : 1;
  }

  if (strcmp(mode, "fault") == 0) {
    readback_buffer();
    /* Valid header and records, but the stream claims another context:
     * the executor must refuse it and fault only this context. */
    clear_stream(context + 1000, 1);
    r = submit(context, 1, &seqno);
    printf("submit %d %llu\n", r, (unsigned long long)seqno);
    if (r != 0) return 1;
    printf("wait %d\n", wait_for(context, seqno));
    /* The lost context refuses new work. */
    clear_stream(context, 1);
    printf("resubmit %d\n", submit(context, 1, &seqno));
    return 0;
  }

  if (strcmp(mode, "lose") == 0) {
    uint32_t busy = 0;
    r = create(&busy);
    printf("create-busy %d %u\n", r, busy);
    if (r != 0) return 1;
    readback_buffer();
    clear_stream(busy, 1);
    r = submit(busy, 1, &seqno);
    printf("submit %d %llu\n", r, (unsigned long long)seqno);
    if (r != 0) return 1;
    printf("wait %d\n", wait_for(busy, seqno));
    char go;
    if (read(0, &go, 1) != 1) return 1;
    /* The context that was idle when the renderer was lost. */
    clear_stream(context, 1);
    printf("idle-submit %d\n", submit(context, 1, &seqno));
    uint32_t later = 0;
    printf("create-after %d\n", create(&later));
    return 0;
  }

  if (strcmp(mode, "many") == 0 && argc == 3) {
    long count = atol(argv[2]);
    /* 64 read buffers make each record large, so the batch overflows both
     * the kernel outbox and the GPU worker's submission ring. */
    for (int i = 0; i < KGPU_MAX_BUFFERS; i++)
      buffers[i] = (struct kgpu_buffer){
          .addr = (uintptr_t)pixels, .len = sizeof pixels, .access = KGPU_ACCESS_READ};
    clear_stream(context, 0);
    uint64_t first = 0, last = 0;
    for (long i = 0; i < count; i++) {
      r = submit(context, KGPU_MAX_BUFFERS, &seqno);
      if (r != 0) {
        printf("many-failed %ld %d\n", i, r);
        return 1;
      }
      if (i == 0) first = seqno;
      if (seqno != (i == 0 ? first : last + 1)) {
        printf("many-order %ld %llu %llu\n", i, (unsigned long long)seqno, (unsigned long long)last);
        return 1;
      }
      last = seqno;
    }
    long waited = 0;
    for (uint64_t s = first; s <= last; s++) {
      r = wait_for(context, s);
      if (r != 0) {
        printf("many-wait %llu %d\n", (unsigned long long)s, r);
        return 1;
      }
      waited++;
    }
    printf("many %ld %llu %llu\n", waited, (unsigned long long)first, (unsigned long long)last);
    return 0;
  }
  return 2;
}
