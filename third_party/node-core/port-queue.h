// Entangled endpoint ownership shared by the engine bridge and native controls.
// Payload serialization belongs to its engine; this owns ordered delivery,
// ref/start/close state and synchronized endpoint lifetime, never JS objects.
#ifndef KANDELO_NODE_PORT_QUEUE_H
#define KANDELO_NODE_PORT_QUEUE_H
#include <chrono>
#include <condition_variable>
#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <utility>

namespace kandelo::ports {
template<class Message> class Endpoint {
  struct State {
    std::list<std::shared_ptr<Message>> messages;
    bool started = false, referenced = true, closing = false, closed = false;
    bool remoteClosed = false, closeNotification = false;
  };
  struct Channel {
    std::mutex mutex;
    std::condition_variable changed;
    State sides[2];
    bool entangled = true;
  };
  std::shared_ptr<Channel> channel_;
  unsigned side_;
  State& Self() const { return channel_->sides[side_]; }
  State& Peer() const { return channel_->sides[side_ ^ 1]; }
  void CompleteClose(std::list<std::shared_ptr<Message>>& retired) const noexcept {
    auto& state = Self();
    state.closed = true; state.closing = false; state.started = false;
    state.closeNotification = true;
    // Dropping a packet can close a transferred endpoint, including one in
    // this channel. Retire payloads only after releasing the channel mutex.
    retired.swap(state.messages);
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
  using Owner = std::shared_ptr<Endpoint>;
  enum class Kind { Empty, MessageValue, Close };
  struct Result { Kind kind; std::shared_ptr<Message> message; };
  static auto Pair() {
    auto channel = std::make_shared<Channel>();
    return std::pair<std::shared_ptr<Endpoint>, std::shared_ptr<Endpoint>>(
        new Endpoint(channel, 0), new Endpoint(channel, 1));
  }
  static std::shared_ptr<Endpoint> Unentangled() {
    auto channel = std::make_shared<Channel>();
    channel->entangled = false;
    return std::shared_ptr<Endpoint>(new Endpoint(std::move(channel), 0));
  }
  ~Endpoint() { Abandon(); }
  Endpoint(const Endpoint&) = delete;
  Endpoint& operator=(const Endpoint&) = delete;
  bool Send(std::shared_ptr<Message> message) {
    std::lock_guard<std::mutex> lock(channel_->mutex);
    if (!channel_->entangled || Self().closed || Self().closing || Peer().closed) return false;
    Peer().messages.push_back(std::move(message));
    channel_->changed.notify_all(); return true;
  }
  Result Receive(bool force = false) {
    std::list<std::shared_ptr<Message>> retired;
    std::lock_guard<std::mutex> lock(channel_->mutex);
    if (!Ready(force)) return {Kind::Empty, {}};
    auto& state = Self();
    if (state.closeNotification) return {Kind::Close, {}};
    if (state.closing || (state.messages.empty() && state.remoteClosed)) {
      CompleteClose(retired); return {Kind::Close, {}};
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
  bool Started() const {
    std::lock_guard<std::mutex> lock(channel_->mutex);
    return Self().started;
  }
  bool IsPeerOf(const Endpoint& other) const noexcept {
    return channel_ == other.channel_ && channel_->entangled && side_ != other.side_;
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
    std::list<std::shared_ptr<Message>> retired;
    std::lock_guard<std::mutex> lock(channel_->mutex);
    if (!Self().closed) CompleteClose(retired);
    Self().closeNotification = false;
  }
  template<class Rep, class Period>
  bool WaitForReady(const std::chrono::duration<Rep, Period>& timeout) {
    std::unique_lock<std::mutex> lock(channel_->mutex);
    return channel_->changed.wait_for(lock, timeout, [&] { return Ready(false); });
  }
};

// A clone packet owns a detached endpoint until one receiver commits its
// adoption. Discarding the packet closes that exact endpoint; destroying the
// source wrapper must never close the endpoint after authority has moved.
template<class Message> class EndpointTransfer {
  std::mutex mutex_;
  std::shared_ptr<Endpoint<Message>> endpoint_;
  bool reading_ = false;
 public:
  EndpointTransfer() = default;
  EndpointTransfer(const EndpointTransfer&) = delete;
  EndpointTransfer& operator=(const EndpointTransfer&) = delete;
  ~EndpointTransfer() { Abort(); }
  void Install(std::shared_ptr<Endpoint<Message>> endpoint) noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    endpoint_ = std::move(endpoint);
  }
  std::shared_ptr<Endpoint<Message>> BeginRead() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (reading_ || !endpoint_) return {};
    reading_ = true;
    return endpoint_;
  }
  bool CommitRead() noexcept {
    std::shared_ptr<Endpoint<Message>> released;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!reading_ || !endpoint_) return false;
      released = std::move(endpoint_); reading_ = false;
    }
    return true;
  }
  bool TargetsPeerOf(const Endpoint<Message>& source) {
    std::lock_guard<std::mutex> lock(mutex_);
    return endpoint_ && endpoint_->IsPeerOf(source);
  }
  void Abort() noexcept {
    std::shared_ptr<Endpoint<Message>> endpoint;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      endpoint = std::move(endpoint_); reading_ = false;
    }
    if (endpoint) endpoint->Abandon();
  }
};

// Named process-wide groups reuse the endpoint queue for actual delivery and
// liveness. Registry entries never own a Member: its destructor removes its
// pointer under the same mutex used for dispatch before destroying its fields.
// Named close leaves other members connected. The pinned Node owner also
// applies its anonymous-pair close rule to the empty string group key.
template<class Message, class Port = Endpoint<Message>> class BroadcastRegistry {
 public:
  class Member;
  enum class Posted { Closed, NoDestinations, Delivered };
 private:
  struct State {
    std::mutex mutex;
    std::map<std::string, std::set<Member*>> groups;
  };
  std::shared_ptr<State> state_ = std::make_shared<State>();
 public:
  class Member {
    friend class BroadcastRegistry;
    std::shared_ptr<State> state_;
    const std::string name_;
    typename Port::Owner receiver_, ingress_;
    bool attached_ = false;  // Protected by the registry mutex.
    Member(std::shared_ptr<State> state, const std::string& name)
        : state_(std::move(state)), name_(name) {
      auto pair = Port::Pair();
      receiver_ = std::move(pair.first); ingress_ = std::move(pair.second);
    }
   public:
    ~Member() { Close(true); }
    Member(const Member&) = delete;
    Member& operator=(const Member&) = delete;
    const typename Port::Owner& Receiver() const { return receiver_; }
    void Close(bool abandon = false) noexcept {
      std::lock_guard<std::mutex> lock(state_->mutex);
      auto found = state_->groups.find(name_);
      if (found != state_->groups.end()) {
        found->second.erase(this);
        if (found->second.empty()) state_->groups.erase(found);
        else if (name_.empty() && found->second.size() == 1)
          (*found->second.begin())->receiver_->Close();
      }
      attached_ = false;
      if (abandon) receiver_->Abandon(); else receiver_->Close();
      ingress_->Abandon();
    }
    // The factory allocates a native delivery envelope only; it must never
    // enter JS or invoke external callbacks while the membership lock is held.
    // Each recipient gets a separate consume-once envelope over shared,
    // immutable, transfer-free serialized data. No reserialization of getters.
    template<class Factory> Posted Post(Factory&& makeMessage) {
      std::lock_guard<std::mutex> lock(state_->mutex);
      if (!attached_ || receiver_->IsClosed()) return Posted::Closed;
      const auto& members = state_->groups.at(name_);
      if (members.size() <= 1) return Posted::NoDestinations;
      bool sent = false;
      for (auto* member : members) {
        if (member != this) sent = member->ingress_->Send(makeMessage()) || sent;
      }
      return sent ? Posted::Delivered : Posted::NoDestinations;
    }
  };
  std::shared_ptr<Member> Join(const std::string& name) {
    auto member = std::shared_ptr<Member>(new Member(state_, name));
    {
      // Keep allocation outside Member teardown's lock lifetime on failure.
      std::lock_guard<std::mutex> lock(state_->mutex);
      state_->groups[name].insert(member.get()); member->attached_ = true;
    }
    return member;
  }
};
}  // namespace kandelo::ports
#endif
