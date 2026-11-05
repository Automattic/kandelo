class TickObject {
  constructor(callback, args, asyncId, triggerAsyncId) {
    this[async_id_symbol] = asyncId;
    this[trigger_async_id_symbol] = triggerAsyncId;
    this[async_context_frame] = AsyncContextFrame.current();
    this.callback = callback;
    this.args = args;
  }
}
