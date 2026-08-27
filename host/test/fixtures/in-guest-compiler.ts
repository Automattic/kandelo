/** Shared real guest programs for Node and browser compiler acceptance. */
export const guestCompilerCases = [
  {
    name: "int-main",
    compiler: "cc",
    extension: "c",
    args: "",
    exitCode: 0,
    output: "guest int main OK",
    source: '#include <stdio.h>\nint main(void) { puts("guest int main OK"); return 0; }\n',
  },
  {
    name: "argc-main",
    compiler: "cc",
    extension: "c",
    args: " kandelo",
    exitCode: 23,
    output: "guest argc main OK",
    source: '#include <stdio.h>\n#include <string.h>\nint main(int argc, char **argv) { if (argc != 2 || strcmp(argv[1], "kandelo")) return 9; puts("guest argc main OK"); return 23; }\n',
  },
  {
    name: "void-main",
    compiler: "cc",
    extension: "c",
    args: "",
    exitCode: 0,
    output: "guest void main OK",
    source: '#include <stdio.h>\nvoid main(void) { puts("guest void main OK"); }\n',
  },
  {
    name: "mmap-writeback",
    compiler: "cc",
    extension: "c",
    args: "",
    exitCode: 0,
    output: "guest mmap writeback OK",
    source: `#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>
int main(void) {
  int fd = open("/tmp/compiler-mmap", O_CREAT | O_TRUNC | O_RDWR, 0600);
  if (fd < 0 || ftruncate(fd, 65536)) return 1;
  char *p = mmap(0, 65536, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (p == MAP_FAILED) return 2;
  p[0] = 'K';
  if (munmap(p, 65536)) return 3;
  char value = 0;
  if (pread(fd, &value, 1, 0) != 1 || value != 'K') return 4;
  if (close(fd) || unlink("/tmp/compiler-mmap")) return 5;
  puts("guest mmap writeback OK");
  return 0;
}
`,
  },
  {
    name: "static-library",
    compiler: "cc",
    extension: "c",
    args: "",
    exitCode: 0,
    output: "guest static library OK:42",
    librarySource: 'int compiler_answer(void) { return 42; }\n',
    source: '#include <stdio.h>\nextern int compiler_answer(void);\nint main(void) { int answer = compiler_answer(); if (answer != 42) return 9; printf("guest static library OK:%d\\n", answer); return 0; }\n',
  },
  {
    name: "cpp-main",
    compiler: "c++",
    extension: "cpp",
    args: "",
    exitCode: 0,
    output: "guest C++ main OK:42",
    source: '#include <cstdio>\nint main() { std::printf("guest C++ main OK:%d\\n", 42); return 0; }\n',
  },
  {
    name: "cpp-entropy",
    compiler: "c++",
    extension: "cpp",
    args: "",
    exitCode: 0,
    output: "guest C++ entropy OK:42",
    source: `#include <cstdio>
#include <numeric>
#include <random>
#include <vector>
int main() {
  std::vector<int> values{10, 20, 12};
  std::random_device entropy;
  const unsigned first = entropy();
  bool different = false;
  for (int i = 0; i < 32; ++i) different |= entropy() != first;
  if (!different) return 9;
  std::printf("guest C++ entropy OK:%d\\n", std::accumulate(values.begin(), values.end(), 0));
  return 0;
}
`,
  },
] as const;

export function guestCompileCommand(sample: typeof guestCompilerCases[number]): string {
  const library = 'librarySource' in sample
    ? "cat > /tmp/compiler-answer.c <<'KANDELO_LIBRARY'\n" + sample.librarySource +
      "KANDELO_LIBRARY\n" +
      "cc -c /tmp/compiler-answer.c -o /tmp/compiler-answer.o\n" +
      "wasm32posix-ar rcs /tmp/libcompiler-answer.a /tmp/compiler-answer.o\n" +
      "wasm32posix-ranlib /tmp/libcompiler-answer.a\n" +
      "symbols=$(wasm32posix-nm --defined-only /tmp/libcompiler-answer.a)\n" +
      'case "$symbols" in *" T compiler_answer"*) ;; *) exit 9 ;; esac\n'
    : "";
  return library + `cat > /tmp/${sample.name}.${sample.extension} <<'KANDELO_SOURCE'\n` +
    sample.source + "KANDELO_SOURCE\n" +
    `${sample.compiler} /tmp/${sample.name}.${sample.extension} -o /tmp/${sample.name}` +
    ('librarySource' in sample ? " /tmp/libcompiler-answer.a" : "");
}
