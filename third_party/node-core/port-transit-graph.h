// Native transit ownership: external owner slots are roots, owning slots are
// edges. Neither shared_ptr reference counts nor JS liveness guesses are roots.
#ifndef KANDELO_NODE_PORT_TRANSIT_GRAPH_H
#define KANDELO_NODE_PORT_TRANSIT_GRAPH_H
#include <cassert>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <utility>

namespace kandelo::ports::transit {
class Graph;
class Edge;
class RootLink;
template<class T> class Root;
class Node {
  friend class Graph;
  friend class Edge;
  friend class RootLink;
  enum class State { Live, Retiring, Retired };
  State state_ = State::Live;
  Node *previous_ = nullptr, *next_ = nullptr, *work_ = nullptr, *pinNext_ = nullptr, *retireNext_ = nullptr;
  RootLink* roots_ = nullptr;
  Edge* edges_ = nullptr;
  std::weak_ptr<Node> self_;
  std::shared_ptr<Node> collectionPin_;
  bool registered_ = false, known_ = false, marked_ = false;
 protected:
  // Called only for a root-unreachable node after the graph barrier is dropped.
  // Implementations retire native data and must never invoke JS or collect GC.
  virtual void Retire() noexcept = 0;
 public:
  Node() = default;
  Node(const Node&) = delete;
  Node& operator=(const Node&) = delete;
  virtual ~Node();
  std::shared_ptr<Node> Share() const noexcept { return self_.lock(); }
};
class Graph {
  friend class Node;
  friend class Edge;
  friend class RootLink;
  std::recursive_mutex mutex_;
  std::condition_variable_any finished_;
  Node* nodes_ = nullptr;
  bool dirty_ = false, collecting_ = false;
  void Register(const std::shared_ptr<Node>& node) noexcept {
    if (node->registered_) return;
    node->self_ = node; node->registered_ = node->known_ = true;
    node->next_ = nodes_;
    if (nodes_) nodes_->previous_ = node.get();
    nodes_ = node.get();
  }
  void Remove(Node& node) noexcept {
    if (!node.registered_) return;
    if (node.previous_) node.previous_->next_ = node.next_;
    else nodes_ = node.next_;
    if (node.next_) node.next_->previous_ = node.previous_;
    node.previous_ = node.next_ = nullptr; node.registered_ = false;
  }
 public:
  using Lock = std::unique_lock<std::recursive_mutex>;
  static Graph& Process() {
    // Registry metadata has process lifetime. A BroadcastRegistry can be
    // constructed before its first endpoint initializes this graph; ordinary
    // reverse static destruction would then destroy the mutex before those
    // genuine registry owner slots release. Context shutdown still retires
    // native payloads; this sentinel must outlive all static owner slots.
    static Graph* graph = new Graph;
    return *graph;
  }
  Lock Barrier() { return Lock(mutex_); }
  // Allocation-free: self-pins are collector bookkeeping, never semantic roots.
  // An admission after the mark must reject a Retiring node; it cannot revive
  // an unreachable queue while another thread retires its native payload.
  size_t Collect(bool waitForActive = false) noexcept;
};
class RootLink {
  friend class Graph;
  Node* node_ = nullptr;
  RootLink *previous_ = nullptr, *next_ = nullptr;
 public:
  RootLink() = default;
  RootLink(const RootLink&) = delete;
  RootLink& operator=(const RootLink&) = delete;
  ~RootLink() { Reset(); }
  bool Attach(const std::shared_ptr<Node>& node) {
    if (!node) return false;
    auto& graph = Graph::Process(); auto lock = graph.Barrier();
    assert(!node_);
    if (!node || node->state_ != Node::State::Live) return false;
    graph.Register(node); node_ = node.get(); next_ = node_->roots_;
    if (next_) next_->previous_ = this;
    node_->roots_ = this; return true;
  }
  void Reset() noexcept {
    if (!node_) return;
    auto& graph = Graph::Process(); auto lock = graph.Barrier();
    if (previous_) previous_->next_ = next_; else node_->roots_ = next_;
    if (next_) next_->previous_ = previous_;
    node_ = nullptr; previous_ = next_ = nullptr; graph.dirty_ = true;
  }
  void MoveFrom(RootLink& other) noexcept {
    assert(!node_);
    if (!other.node_) return;
    auto& graph = Graph::Process(); auto lock = graph.Barrier();
    assert(!node_);
    node_ = other.node_; previous_ = other.previous_; next_ = other.next_;
    if (node_) {
      if (previous_) previous_->next_ = this; else node_->roots_ = this;
      if (next_) next_->previous_ = this;
    }
    other.node_ = nullptr; other.previous_ = other.next_ = nullptr;
  }
};
template<class T> class Root {
  std::shared_ptr<T> value_;
  RootLink link_;
 public:
  Root() = default;
  explicit Root(std::shared_ptr<T> value) : value_(std::move(value)) {
    if (!link_.Attach(std::static_pointer_cast<Node>(value_))) value_.reset();
  }
  Root(const Root& other) : Root(other.value_) {}
  Root(Root&& other) noexcept : value_(std::move(other.value_)) { link_.MoveFrom(other.link_); }
  Root& operator=(const Root& other) { Root copy(other); *this = std::move(copy); return *this; }
  Root& operator=(Root&& other) noexcept {
    if (this != &other) { reset(); value_ = std::move(other.value_); link_.MoveFrom(other.link_); }
    return *this;
  }
  ~Root() { reset(); }
  void reset() noexcept { link_.Reset(); value_.reset(); }
  explicit operator bool() const noexcept { return bool(value_); }
  T* get() const noexcept { return value_.get(); }
  T* operator->() const noexcept { return value_.get(); }
  T& operator*() const noexcept { return *value_; }
  std::shared_ptr<T> Share() const noexcept { return value_; }
};
class Edge {
  friend class Graph;
  Node* source_ = nullptr;
  std::shared_ptr<Node> target_;
  Edge *previous_ = nullptr, *next_ = nullptr;
 public:
  Edge() = default;
  Edge(const Edge&) = delete;
  Edge& operator=(const Edge&) = delete;
  ~Edge() { Reset(); }
  bool Attach(const std::shared_ptr<Node>& source, const std::shared_ptr<Node>& target) {
    auto& graph = Graph::Process(); auto lock = graph.Barrier();
    assert(!source_);
    if (!source || !target || source->state_ != Node::State::Live || target->state_ != Node::State::Live) return false;
    graph.Register(source); graph.Register(target);
    source_ = source.get(); target_ = target; next_ = source_->edges_;
    if (next_) next_->previous_ = this;
    source_->edges_ = this; return true;
  }
  void Reset() noexcept {
    if (!source_) return;
    std::shared_ptr<Node> released;
    {
      auto& graph = Graph::Process(); auto lock = graph.Barrier();
      if (!source_) return;
      if (previous_) previous_->next_ = next_; else source_->edges_ = next_;
      if (next_) next_->previous_ = previous_;
      source_ = nullptr; previous_ = next_ = nullptr;
      released = std::move(target_); graph.dirty_ = true;
    }
  }
};
inline Node::~Node() {
  if (!known_) { assert(!roots_ && !edges_); return; }
  auto& graph = Graph::Process(); auto lock = graph.Barrier();
  assert(!roots_ && !edges_); graph.Remove(*this);
}
inline size_t Graph::Collect(bool waitForActive) noexcept {
  Node *pins = nullptr, *work = nullptr, *retired = nullptr;
  {
    auto lock = Barrier();
    if (waitForActive) finished_.wait(lock, [&] { return !collecting_; });
    if (collecting_ || !dirty_) return 0;
    collecting_ = true; dirty_ = false;
    for (Node* node = nodes_; node;) {
      Node* next = node->next_;
      auto pin = node->self_.lock();
      if (!pin) { Remove(*node); node = next; continue; }
      node->collectionPin_ = std::move(pin); node->pinNext_ = pins; pins = node;
      node->marked_ = false;
      node = next;
    }
    for (Node* node = pins; node; node = node->pinNext_) {
      if (node->state_ == Node::State::Live && node->roots_) {
        node->marked_ = true; node->work_ = work; work = node;
      }
    }
    while (work) {
      Node* node = work; work = node->work_; node->work_ = nullptr;
      for (Edge* edge = node->edges_; edge; edge = edge->next_) {
        Node* target = edge->target_.get();
        if (!target->marked_ && target->state_ == Node::State::Live) {
          target->marked_ = true; target->work_ = work; work = target;
        }
      }
    }
    for (Node* node = pins; node; node = node->pinNext_) {
      if (node->state_ == Node::State::Live && !node->marked_) {
        node->state_ = Node::State::Retiring; node->retireNext_ = retired; retired = node;
      }
    }
  }
  size_t count = 0;
  while (retired) {
    Node* node = retired; retired = node->retireNext_; node->retireNext_ = nullptr;
    node->Retire();
    { auto lock = Barrier(); node->state_ = Node::State::Retired; }
    ++count;
  }
  while (pins) {
    Node* node = pins; pins = node->pinNext_; node->pinNext_ = nullptr;
    auto released = std::move(node->collectionPin_);
  }
  { auto lock = Barrier(); collecting_ = false; }
  finished_.notify_all();
  return count;
}
} // namespace kandelo::ports::transit
#endif
