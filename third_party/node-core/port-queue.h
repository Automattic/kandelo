// Entangled endpoint ownership shared by the engine bridge and native controls.
// Payload serialization belongs to its engine; this owns ordered delivery,
// ref/start/close state and synchronized endpoint lifetime, never JS objects.
#ifndef KANDELO_NODE_PORT_QUEUE_H
#define KANDELO_NODE_PORT_QUEUE_H
#include <chrono>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <utility>

namespace kandelo::ports {
template<class Message> class Endpoint {
  struct State {
    std::deque<std::shared_ptr<Message>> messages;
    bool started = false, referenced = true, closing = false, closed = false;
    bool remoteClosed = false, closeNotification = false;
  };
  struct Channel {
    std::mutex mutex;
    std::condition_variable changed;
    State sides[2];
  };
  std::shared_ptr<Channel> channel_;
  unsigned side_;
  State& Self() const { return channel_->sides[side_]; }
  State& Peer() const { return channel_->sides[side_ ^ 1]; }
  void CompleteClose() const noexcept {
    auto& state = Self();
    state.closed = true; state.closing = false; state.started = false;
    state.closeNotification = true;
    state.messages.clear();
    // This logical terminal marker follows every already-enqueued packet.
    // No allocation is allowed on finalization/close cleanup paths.
    Peer().remoteClosed = true;
    channel_->changed.notify_all();
  }
  bool Ready(bool force) const {
    const auto& state = Self();
    return state.closeNotification || (!state.closed && (state.closing ||
        (!state.messages.empty() ? state.started || force : state.remoteClosed)));
  }
  Endpoint(std::shared_ptr<Channel> channel, unsigned side)
      : channel_(std::move(channel)), side_(side) {}
 public:
  enum class Kind { Empty, MessageValue, Close };
  struct Result { Kind kind; std::shared_ptr<Message> message; };
  static auto Pair() {
    auto channel = std::make_shared<Channel>();
    return std::pair<std::shared_ptr<Endpoint>, std::shared_ptr<Endpoint>>(
        new Endpoint(channel, 0), new Endpoint(channel, 1));
  }
  ~Endpoint() { Abandon(); }
  Endpoint(const Endpoint&) = delete;
  Endpoint& operator=(const Endpoint&) = delete;
  bool Send(std::shared_ptr<Message> message) {
    std::lock_guard<std::mutex> lock(channel_->mutex);
    if (Self().closed || Self().closing || Peer().closed) return false;
    Peer().messages.push_back(std::move(message));
    channel_->changed.notify_all(); return true;
  }
  Result Receive(bool force = false) {
    std::lock_guard<std::mutex> lock(channel_->mutex);
    if (!Ready(force)) return {Kind::Empty, {}};
    auto& state = Self();
    if (state.closeNotification) return {Kind::Close, {}};
    if (state.closing || (state.messages.empty() && state.remoteClosed)) {
      CompleteClose(); return {Kind::Close, {}};
    }
    auto packet = std::move(state.messages.front()); state.messages.pop_front();
    return {Kind::MessageValue, std::move(packet)};
  }
  void Start(bool started) {
    std::lock_guard<std::mutex> lock(channel_->mutex);
    if (!Self().closed && !Self().closing) Self().started = started;
    channel_->changed.notify_all();
  }
  void Ref(bool referenced) {
    std::lock_guard<std::mutex> lock(channel_->mutex);
    if (!Self().closed && !Self().closing) Self().referenced = referenced;
    channel_->changed.notify_all();
  }
  bool HasRef() const {
    std::lock_guard<std::mutex> lock(channel_->mutex);
    return !Self().closed && !Self().closing && Self().referenced;
  }
  bool IsClosed() const {
    std::lock_guard<std::mutex> lock(channel_->mutex);
    return Self().closed || Self().closing;
  }
  bool KeepsLoopAlive() const {
    std::lock_guard<std::mutex> lock(channel_->mutex);
    // A direct ref() keeps even an unstarted port alive. Completion of a
    // requested close is independent of its previous reference policy.
    return Self().closeNotification || (!Self().closed && (Self().referenced || Self().closing ||
        (Self().messages.empty() && Self().remoteClosed)));
  }
  void Close() {
    std::lock_guard<std::mutex> lock(channel_->mutex);
    if (!Self().closed) Self().closing = true;
    channel_->changed.notify_all();
  }
  void AcknowledgeClose() {
    std::lock_guard<std::mutex> lock(channel_->mutex);
    Self().closeNotification = false;
  }
  void Abandon() noexcept {
    std::lock_guard<std::mutex> lock(channel_->mutex);
    if (!Self().closed) CompleteClose();
    Self().closeNotification = false;
  }
  template<class Rep, class Period>
  bool WaitForReady(const std::chrono::duration<Rep, Period>& timeout) {
    std::unique_lock<std::mutex> lock(channel_->mutex);
    return channel_->changed.wait_for(lock, timeout, [&] { return Ready(false); });
  }
};
}  // namespace kandelo::ports
#endif
