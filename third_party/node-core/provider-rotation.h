#ifndef KANDELO_NODE_PROVIDER_ROTATION_H
#define KANDELO_NODE_PROVIDER_ROTATION_H
namespace kandelo::node_loop {
enum class Provider { Work, Ports, Workers, Locks };
// Only an actual completion advances the cursor. At most one provider enters
// JS per dispatch, followed by the engine's normal tick/job checkpoint. A ready
// provider is attempted within four progressing turns even under continuous
// traffic from the others; readiness does not create a loop reference.
class ProviderRotation {
  unsigned next_ = 0;
 public:
  template<class Attempt>
  int Dispatch(Attempt&& attempt) {
    for (unsigned offset = 0; offset < 4; ++offset) {
      const unsigned index = (next_ + offset) % 4;
      const int result = attempt(static_cast<Provider>(index));
      if (result > 0) { next_ = (index + 1) % 4; return result; }
      if (result < 0) return result;
    }
    return 0;
  }
};
}  // namespace kandelo::node_loop
#endif
