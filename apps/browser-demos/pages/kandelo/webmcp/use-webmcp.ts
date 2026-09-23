import * as React from 'react';
import { registerWebMcp, type AppBindings } from './adapter';

export function useWebMcp(bindings: AppBindings): void {
  const latest = React.useRef(bindings);
  latest.current = bindings;
  const adapter = React.useRef<ReturnType<typeof registerWebMcp> | null>(null);
  React.useEffect(() => {
    const dispose = registerWebMcp(() => latest.current);
    adapter.current = dispose;
    return () => { adapter.current = null; dispose(); };
  }, [bindings.host]);
  React.useEffect(() => { adapter.current?.sync?.(); });
}
