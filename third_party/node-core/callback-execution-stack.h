// Owning execution records shared by actual native callback and JS scopes.
// Payload roots/captured-frame policy belong to the embedding. No JS runtime,
// Node API, scheduler or synthetic async resource is introduced here.
#ifndef KANDELO_NODE_CALLBACK_EXECUTION_STACK_H
#define KANDELO_NODE_CALLBACK_EXECUTION_STACK_H
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <utility>
namespace kandelo::async {
template<class Payload> class ExecutionStack {
 public:
  enum class Owner { NativeScope, JavaScriptScope };
  struct Info { size_t allocationBytes; Owner owner; double id; double trigger; };
  enum class PopResult { Empty, WrongId, PoppedEmpty, PoppedMore };
 private:
  struct Node {
    Node* previous;
    unsigned references = 1; // Active stack, plus exactly one native token.
    bool active = true;
    const uint64_t epoch;
    const double id, trigger, priorId, priorTrigger;
    Payload payload;
    template<class... Args>
    Node(Node* previous, uint64_t epoch, double id, double trigger,
         double priorId, double priorTrigger, Owner owner, Args&&... args)
        : previous(previous), epoch(epoch), id(id), trigger(trigger),
          priorId(priorId), priorTrigger(priorTrigger),
          payload(Info{sizeof(Node),owner,id,trigger},std::forward<Args>(args)...) {}
    static void Release(Node* node) noexcept {
      if (!node->references) std::abort();
      if (--node->references == 0) delete node;
    }
  };
  Node* top_ = nullptr;
  double id_ = 0, trigger_ = 0;
  size_t depth_ = 0;
  uint64_t epoch_ = 0;
  Node* UnlinkTop() noexcept {
    Node* node=top_;
    top_=node->previous; node->previous=nullptr; node->active=false;
    id_=node->priorId; trigger_=node->priorTrigger; --depth_;
    return node;
  }
  template<class... Args>
  Node* Push(double id,double trigger,Owner owner,Args&&... args) {
    // No mutation or borrowed payload publication precedes successful native
    // allocation/root construction. A throwing payload leaves the prior stack.
    auto node=std::make_unique<Node>(top_,epoch_,id,trigger,id_,trigger_,owner,
                                     std::forward<Args>(args)...);
    Node* result=node.release(); top_=result; id_=id; trigger_=trigger; ++depth_;
    return result;
  }
 public:
  class Token {
    friend class ExecutionStack;
    ExecutionStack* stack_=nullptr;
    Node* node_=nullptr;
    Token(ExecutionStack& stack,Node* node) noexcept:stack_(&stack),node_(node) {
      ++node_->references;
    }
    void Release() noexcept {
      if(!node_)return;
      // A token cannot silently retire a different still-active callback.
      if(!Close())std::abort();
      Node::Release(node_);node_=nullptr;stack_=nullptr;
    }
   public:
    Token() noexcept=default;
    Token(const Token&)=delete;
    Token& operator=(const Token&)=delete;
    Token(Token&& other) noexcept:stack_(other.stack_),node_(other.node_) {
      other.stack_=nullptr;other.node_=nullptr;
    }
    Token& operator=(Token&& other) noexcept {
      if(this!=&other){Release();stack_=other.stack_;node_=other.node_;other.stack_=nullptr;other.node_=nullptr;}
      return *this;
    }
    ~Token(){Release();}
    bool Active() const noexcept { return node_&&node_->active; }
    bool Cleared() const noexcept { return node_&&node_->epoch!=stack_->epoch_; }
    Payload* Data() noexcept { return node_?&node_->payload:nullptr; }
    const Payload* Data() const noexcept { return node_?&node_->payload:nullptr; }
    bool Close() noexcept {
      if(!node_||!node_->active)return true;
      if(stack_->top_!=node_)return false;
      Node::Release(stack_->UnlinkTop());return true;
    }
  };
  ExecutionStack()=default;
  ExecutionStack(const ExecutionStack&)=delete;
  ExecutionStack& operator=(const ExecutionStack&)=delete;
  ~ExecutionStack(){Clear();}
  double Id() const noexcept{return id_;}
  double Trigger() const noexcept{return trigger_;}
  size_t Depth() const noexcept{return depth_;}
  uint64_t Epoch() const noexcept{return epoch_;}
  bool Empty() const noexcept{return top_==nullptr;}
  Payload* Top() noexcept{return top_?&top_->payload:nullptr;}
  const Payload* Top() const noexcept{return top_?&top_->payload:nullptr;}
  template<class... Args>
  Token PushNative(double id,double trigger,Args&&... args){
    return Token(*this,Push(id,trigger,Owner::NativeScope,std::forward<Args>(args)...));
  }
  template<class... Args>
  void PushJavaScript(double id,double trigger,Args&&... args){
    Push(id,trigger,Owner::JavaScriptScope,std::forward<Args>(args)...);
  }
  template<class... Args>
  void PushScope(double id,double trigger,Owner owner,Args&&... args){
    Push(id,trigger,owner,std::forward<Args>(args)...);
  }
  // `observe` must not invoke JS, mutate this stack or throw. The popped
  // payload remains owned until it has copied its real prior snapshot into
  // the caller's existing root. Native tokens keep their payload afterward.
  template<class Observe>
  PopResult Pop(double expected,Observe observe) noexcept {
    if(!top_)return PopResult::Empty;
    if(id_!=expected)return PopResult::WrongId;
    Node* node=UnlinkTop();
    observe(node->payload);
    Node::Release(node);
    return top_?PopResult::PoppedMore:PopResult::PoppedEmpty;
  }
  void Clear() noexcept {
    if(epoch_==UINT64_MAX)std::abort();
    ++epoch_;
    while(top_)Node::Release(UnlinkTop());
    // The actual empty environment execution state, not a captured task ID.
    id_=0;trigger_=0;
  }
};
} // namespace kandelo::async
#endif
