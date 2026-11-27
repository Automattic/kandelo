/*
 * Guest side of host/test/kgpu-boundary.test.ts: drive the kandelo.kgpu.v1
 * import through the real process worker and kernel, in steps the test
 * observes on stdout. The program only uses <kandelo/kgpu.h> and
 * <kandelo/kgpu_stream.h>, as a GL driver would.
 *
 * argv[1] is how many one-extent submissions fill the kernel outbox; the
 * test derives it from the generated record sizes and outbox capacity, so
 * the next submission meets a full outbox. Before each fill the program
 * reads one byte of stdin: the test's go-ahead.
 */
#include <kandelo/kgpu.h>
#include <kandelo/kgpu_stream.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

/* 64-byte aligned, so the 16-byte stream is one extent in one page. */
static struct kgpu_stream_header stream __attribute__((aligned(64)));

static int submit(uint32_t context, uint64_t *seqno) {
  struct kgpu_submit s = {
    .context = context,
    .stream_addr = (uintptr_t)&stream,
    .stream_len = sizeof stream,
  };
  int r = __kandelo_kgpu_v1(&s, sizeof s, KGPU_OP_SUBMIT);
  *seqno = s.seqno;
  return r;
}

/* Wait for the test's go-ahead on stdin, so a phase never overlaps the
 * test's drain of the one before it. */
static int gate(void) {
  char go;
  return read(0, &go, 1) == 1 ? 0 : -1;
}

static int fill(uint32_t context, long count, uint64_t *last) {
  for (long i = 0; i < count; i++) {
    int r = submit(context, last);
    if (r != 0) {
      printf("fill-failed %ld %d\n", i, r);
      return r;
    }
  }
  return 0;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  if (argc != 2) return 2;
  long count = atol(argv[1]);
  stream.magic = KGPU_STREAM_MAGIC;
  stream.version = KGPU_STREAM_VERSION;

  /* The import refuses a wrong size or an unknown op before any request. */
  struct kgpu_wait probe = {0};
  printf("bad-size %d\n", __kandelo_kgpu_v1(&probe, sizeof probe - 1, KGPU_OP_WAIT));
  printf("bad-op %d\n", __kandelo_kgpu_v1(&probe, sizeof probe, 9));

  struct kgpu_context_create create = {0};
  int r = __kandelo_kgpu_v1(&create, sizeof create, KGPU_OP_CONTEXT_CREATE);
  printf("create %d %u\n", r, create.context);
  if (r != 0) return 1;
  uint64_t seqno = 0;
  r = submit(create.context, &seqno);
  printf("submit %d %llu\n", r, (unsigned long long)seqno);
  if (r != 0) return 1;

  struct kgpu_wait wait = {
    .context = create.context,
    .seqno = seqno,
    .timeout_ns = -1,
  };
  printf("wait %d\n", __kandelo_kgpu_v1(&wait, sizeof wait, KGPU_OP_WAIT));

  /* Fill the outbox; the next submission is held until the host drains. */
  uint64_t last = 0;
  if (gate() != 0) return 1;
  if (fill(create.context, count, &last) != 0) return 1;
  printf("filled %llu\n", (unsigned long long)last);
  r = submit(create.context, &seqno);
  printf("held %d %llu\n", r, (unsigned long long)seqno);

  /* Fill again; this time the context is lost while the submission waits. */
  if (gate() != 0) return 1;
  if (fill(create.context, count, &last) != 0) return 1;
  printf("filled %llu\n", (unsigned long long)last);
  seqno = 0;
  r = submit(create.context, &seqno);
  printf("lost %d %llu\n", r, (unsigned long long)seqno);
  /* Exit only when told, so the test sees the exit's destroy record alone. */
  return gate() == 0 ? 0 : 1;
}
