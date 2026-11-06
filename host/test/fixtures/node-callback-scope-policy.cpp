// Actual shared C++ policy with explicit deterministic hook/context/queue
// boundaries. Compare visible traces with native Node-API MakeCallback; this
// does not compile or validate the SpiderMonkey JSAPI adapter.
#include "callback-scope.h"
#include <cassert>
#include <deque>
#include <functional>
#include <iostream>
#include <string>
#include <vector>

struct Environment {
  unsigned depth = 0;
  bool ready = true, stop = false, error = false, retired = false, fatalBefore = false;
  bool stopAtCheckpoint = false;
  int checkpoints = 0;
  std::string store = "root";
  std::vector<std::string> trace;
  std::deque<std::function<void()>> ticks, jobs;
  void Task(std::deque<std::function<void()>>& queue, std::function<void()> fn) {
    const auto captured = store;
    queue.push_back([this, captured, fn] {
      const auto prior = store; store = captured; fn(); store = prior;
    });
  }
  void LogTask(const std::string& name) {
    trace.push_back(name + ":" + store + (retired ? ":retired" : ":live"));
  }
  void Queue(const std::string& name) {
    Task(ticks, [this, name] {
      LogTask("tick:" + name);
      Task(jobs, [this, name] { LogTask("job-from-tick:" + name); });
    });
    Task(jobs, [this, name] {
      LogTask("job:" + name);
      Task(ticks, [this, name] { LogTask("tick-from-job:" + name); });
    });
  }
  bool Checkpoint() {
    ++checkpoints;
    do {
      while (!ticks.empty()) { auto fn = ticks.front(); ticks.pop_front(); fn(); }
      while (!jobs.empty()) { auto fn = jobs.front(); jobs.pop_front(); fn(); }
    } while (!ticks.empty());
    return !error;
  }
};
struct Host {
  Environment& env;
  std::string name, frame, prior;
  Host(Environment& env, std::string name, std::string frame)
      : env(env), name(name), frame(frame), prior(env.store) {}
  bool Ready() const { return env.ready; }
  unsigned& Depth() { return env.depth; }
  bool Stopping() const { return env.stop; }
  bool HasError() const { return env.error; }
  bool Before() {
    env.store = frame;
    if (env.fatalBefore) { env.trace.push_back("before-fatal"); env.stop = true; return true; }
    env.trace.push_back("before:" + name + ":" + env.store); return true;
  }
  bool Recover() { return false; }
  bool After() { env.trace.push_back("after:" + name + ":" + env.store); return true; }
  void Restore() { env.store = prior; }
  bool Checkpoint() {
    if (env.stopAtCheckpoint) { env.stop = true; return false; }
    return env.Checkpoint();
  }
};
static void GuardCases() {
  Environment env;
  {
    Host host(env, "guard", "store");
    kandelo::async::CallbackScope<Host> scope(host);
    assert(scope.Enter());
    assert(scope.Close());
    assert(scope.Close());
    assert(env.checkpoints == 1 && env.depth == 1 && env.store == "root");
  }
  assert(env.depth == 0 && env.trace.size() == 2);
  env.ready = false;
  { Host host(env, "unused", "x"); kandelo::async::CallbackScope<Host> scope(host); assert(!scope.Enter()); }
  assert(env.depth == 0 && env.trace.size() == 2);
  env.ready = true; env.error = true;
  {
    Host host(env, "failed", "x"); kandelo::async::CallbackScope<Host> scope(host);
    assert(!scope.Enter());
  }
  assert(env.store == "root" && env.depth == 0 && env.checkpoints == 1);
  { kandelo::async::CallbackEntryDepth entry(&env.depth); assert(env.depth == 1); entry.Close(); entry.Close(); }
  assert(env.depth == 0);
  env.error = false; env.stopAtCheckpoint = true;
  {
    Host host(env, "stopping", "x"); kandelo::async::CallbackScope<Host> scope(host);
    assert(scope.Enter()); assert(scope.Close());
  }
  assert(env.stop && env.depth == 0 && env.store == "root");
}
int main(int argc, char** argv) {
  assert(argc == 2);
  GuardCases();
  const std::string mode = argv[1];
  Environment env;
  env.fatalBefore = mode == "fatal";
  if (mode == "js-entry" || mode == "job-entry" || mode == "timer-entry") {
    {
      kandelo::async::CallbackEntryDepth entry(&env.depth);
      env.store = "outer-store";
      {
        Host host(env, "outer", "outer-store");
        kandelo::async::CallbackScope<Host> scope(host);
        assert(scope.Enter()); env.trace.push_back("body:outer:" + env.store); env.Queue("outer");
        assert(scope.Close()); assert(env.checkpoints == 0);
      }
      env.store = "root"; env.retired = true;
      env.trace.push_back("retire:outer"); env.trace.push_back("continued:js");
      if (mode == "job-entry") {
        // The surrounding engine checkpoint finishes already queued jobs
        // before it returns to the nextTick dispatcher.
        while (!env.jobs.empty()) { auto fn = env.jobs.front(); env.jobs.pop_front(); fn(); }
      }
    }
    assert(env.depth == 0); env.Checkpoint();
    for (const auto& text : env.trace) std::cout << text << '\n';
    return 0;
  }
  {
    Host host(env, "outer", "outer-store");
    kandelo::async::CallbackScope<Host> scope(host);
    if (scope.Enter()) {
      env.trace.push_back("body:outer:" + env.store); env.Queue("outer");
      if (mode == "exit") { env.trace.push_back("process-exit:17"); env.stop = true; }
      if (mode == "nested" || mode == "throw") {
        const auto outerStore = env.store; env.store = "inner-store";
        {
          Host inner(env, "inner", "inner-store");
          kandelo::async::CallbackScope<Host> nested(inner);
          assert(nested.Enter());
          env.trace.push_back("body:inner:" + env.store); env.Queue("inner");
          if (mode == "throw") env.error = true;
          else assert(nested.Close());
        }
        assert(env.checkpoints == 0 && env.depth == 1);
        if (mode == "throw") { env.error = false; env.trace.push_back("caught:" + env.store); }
        env.store = outerStore; env.trace.push_back("continued:outer:" + env.store);
      }
      assert(scope.Close());
    } else assert(scope.Stopped());
  }
  assert(env.store == "root" && env.depth == 0);
  if (mode != "fatal" && mode != "exit") { env.retired = true; env.trace.push_back("retire:outer"); }
  else assert(env.checkpoints == 0);
  if (mode == "fatal") assert(env.ticks.empty() && env.jobs.empty());
  if (mode == "exit") assert(env.ticks.size() == 1 && env.jobs.size() == 1);
  for (const auto& entry : env.trace) std::cout << entry << '\n';
}
