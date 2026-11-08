#include <vector>
static std::vector<int> values{3,4};
extern "C" int from_cpp(void) { return values[0]+values[1]; }
