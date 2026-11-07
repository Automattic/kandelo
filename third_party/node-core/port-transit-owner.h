// Typed native owners over the existing synchronized inbox implementation.
#ifndef KANDELO_NODE_PORT_TRANSIT_OWNER_H
#define KANDELO_NODE_PORT_TRANSIT_OWNER_H
#include "port-queue.h"
#include "port-transit-graph.h"

namespace kandelo::ports {
template<class Message> class TransitEndpoint final : public transit::Node {
  struct Envelope {
    std::shared_ptr<Message> message;
    transit::Edge edge;
  };
  using Inbox = Endpoint<Envelope>;
  std::shared_ptr<Inbox> inbox_;
  std::weak_ptr<TransitEndpoint> peer_;
  explicit TransitEndpoint(std::shared_ptr<Inbox> inbox) : inbox_(std::move(inbox)) {}
  void Retire() noexcept override { inbox_->Abandon(); }
 public:
  using Owner = transit::Root<TransitEndpoint>;
  using Kind = typename Inbox::Kind;
  struct Result { Kind kind; transit::Root<Message> message; };
  static auto Pair() {
    auto barrier = transit::Graph::Process().Barrier();
    auto pair = Inbox::Pair();
    auto a = std::shared_ptr<TransitEndpoint>(new TransitEndpoint(std::move(pair.first)));
    auto b = std::shared_ptr<TransitEndpoint>(new TransitEndpoint(std::move(pair.second)));
    a->peer_ = b; b->peer_ = a;
    return std::pair<Owner, Owner>(Owner(a), Owner(b));
  }
  static Owner Unentangled() {
    return Owner(std::shared_ptr<TransitEndpoint>(new TransitEndpoint(Inbox::Unentangled())));
  }
  ~TransitEndpoint() override { inbox_->Abandon(); }
  bool Send(const transit::Root<Message>& message) {
    auto barrier = transit::Graph::Process().Barrier();
    if (!message) return false;
    // The weak peer is send admission, not an owning path from the sender to
    // the peer's inbox. Only this in-flight publication temporarily roots it.
    Owner peer(peer_.lock());
    if (!peer) return false;
    auto envelope = std::make_shared<Envelope>(); envelope->message = message.Share();
    if (!envelope->edge.Attach(peer.Share(), message.Share())) return false;
    return inbox_->Send(std::move(envelope));
  }
  Result Receive(bool force = false) {
    auto barrier = transit::Graph::Process().Barrier();
    auto result = inbox_->Receive(force);
    if (!result.message) return {result.kind, {}};
    // Register the actual pop/result owner before removing the inbox edge.
    transit::Root<Message> owner(result.message->message);
    assert(owner);
    result.message->edge.Reset();
    return {result.kind, std::move(owner)};
  }
  void Start(bool value) { inbox_->Start(value); }
  void Ref(bool value) { inbox_->Ref(value); }
  bool HasRef() const { return inbox_->HasRef(); }
  bool Started() const { return inbox_->Started(); }
  bool IsClosed() const { return inbox_->IsClosed(); }
  bool IsPeerOf(const TransitEndpoint& other) const noexcept { return inbox_->IsPeerOf(*other.inbox_); }
  bool KeepsLoopAlive() const { return inbox_->KeepsLoopAlive(); }
  void Close() { inbox_->Close(); }
  void AcknowledgeClose() { inbox_->AcknowledgeClose(); }
  void Abandon() noexcept { inbox_->Abandon(); }
  template<class Rep, class Period>
  bool WaitForReady(const std::chrono::duration<Rep, Period>& duration) { return inbox_->WaitForReady(duration); }
};
template<class Message> class TransitTransfer {
  using Port = TransitEndpoint<Message>;
  std::shared_ptr<Port> endpoint_;
  transit::Root<Port> reading_;
  transit::Edge edge_;
 public:
  TransitTransfer() = default;
  TransitTransfer(const TransitTransfer&) = delete;
  TransitTransfer& operator=(const TransitTransfer&) = delete;
  ~TransitTransfer() { Abort(); }
  bool Install(const std::shared_ptr<transit::Node>& dataOwner, const typename Port::Owner& endpoint) {
    auto barrier = transit::Graph::Process().Barrier();
    assert(!endpoint_);
    if (!endpoint || !edge_.Attach(dataOwner, endpoint.Share())) return false;
    endpoint_ = endpoint.Share(); return true;
  }
  typename Port::Owner BeginRead() {
    auto barrier = transit::Graph::Process().Barrier();
    if (reading_ || !endpoint_) return {};
    reading_ = typename Port::Owner(endpoint_);
    return reading_;
  }
  bool CommitRead() noexcept {
    auto barrier = transit::Graph::Process().Barrier();
    if (!reading_ || !endpoint_) return false;
    edge_.Reset(); endpoint_.reset(); reading_.reset(); return true;
  }
  bool TargetsPeerOf(const Port& source) {
    auto barrier = transit::Graph::Process().Barrier();
    return endpoint_ && endpoint_->IsPeerOf(source);
  }
  void Abort() noexcept {
    std::shared_ptr<Port> endpoint;
    {
      auto barrier = transit::Graph::Process().Barrier();
      endpoint = std::move(endpoint_); reading_.reset(); edge_.Reset();
    }
    if (endpoint) endpoint->Abandon();
  }
};
} // namespace kandelo::ports
#endif
