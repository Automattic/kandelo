import { AsyncResource } from 'node:async_hooks';

// Native reference boundary for focused scheduler controls. Real AsyncResource
// objects capture context and own destroy events; this is not guest async
// provider or native-job integration evidence.
export function createNativeTaskBoundary() {
  const resources = new WeakMap<object, AsyncResource>();
  return {
    createTask(owner: object, type: string) { resources.set(owner, new AsyncResource(type)); },
    runTask(owner: object, fn: (...args: any[]) => any, receiver: any, args: any[]) {
      const resource = resources.get(owner);
      if (!resource) throw Error('Unregistered test task');
      return resource.runInAsyncScope(fn, receiver, ...args);
    },
    retireTask(owner: object) {
      const resource = resources.get(owner);
      if (resource) { resources.delete(owner); resource.emitDestroy(); }
    },
  };
}
