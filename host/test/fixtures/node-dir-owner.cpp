// Actual portable persistent directory cursor and reservation controls.
#include "../../../third_party/node-core/dir-cursor.h"
#include <cstdio>
#include <unistd.h>
static std::string Hex(const std::string& input) {
  const char* digits = "0123456789abcdef"; std::string output;
  for (unsigned char byte : input) { output += digits[byte >> 4]; output += digits[byte & 15]; }
  return output;
}
int main(int argc, char** argv) {
  if (argc < 3) return 2;
  const auto maximum = uint32_t(std::stoul(argv[2]));
  try {
    int status; auto cursor = kandelo::nodefs::DirectoryCursor::Open(argv[1], &status);
    if (status < 0) { std::printf("{\"status\":%d}\n", status); return 0; }
    if (argc > 3 && ::rename(argv[1], argv[3]) != 0) return 3;
    // A prepared/cancelled native operation cannot permit concurrent I/O or
    // consume entries before dispatch. Reservation release keeps the cursor.
    if (cursor->Reserve() != 0 || cursor->Read(maximum).status != -EBUSY) return 4;
    cursor->Release();
    std::printf("{\"status\":0,\"batches\":["); bool firstBatch = true;
    for (;;) {
      const auto batch = cursor->Read(maximum);
      if (batch.status < 0) return 5;
      if (!firstBatch) std::printf(","); firstBatch = false;
      if (batch.entries.empty()) { std::printf("null"); break; }
      std::printf("["); bool first = true;
      for (const auto& entry : batch.entries) {
        if (!first) std::printf(","); first = false;
        std::printf("[\"%s\",%d]", Hex(entry.name).c_str(), int(entry.type));
      }
      std::printf("]");
    }
    if (!cursor->Read(maximum).entries.empty() || cursor->Close() != 0 || cursor->Read(maximum).status != -EBADF) return 6;
    std::printf("]}\n");
  } catch (const std::exception& error) { std::fprintf(stderr,"%s\n",error.what()); return 1; }
}
