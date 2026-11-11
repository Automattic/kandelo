import { BrowserKernel } from "../../host/src/browser-kernel-host";

let active: {host:BrowserKernel;directory?:string} | undefined;
export async function runRustBrowserDebuggee(options: {
  origin:string; image:boolean; kernel:boolean; argv:string[]; env:string[];
}): Promise<number> {
  if (active) throw new Error("a Rust debuggee is already running on this page");
    const decoders = {stdout:new TextDecoder(),stderr:new TextDecoder()};
    let outputDone = Promise.resolve();
    const output = (stream: 'stdout'|'stderr', bytes?: Uint8Array) => {
      const text = bytes ? decoders[stream].decode(bytes,{stream:true}) : decoders[stream].decode();
      outputDone = outputDone.then(() => (globalThis as any).__rustDebugOutput(stream,text));
    };
    const host = new BrowserKernel({ kernelOwnedFs:true,
      onStdout:(data: Uint8Array) => output('stdout',data), onStderr:(data: Uint8Array) => output('stderr',data) });
    const state: {host:BrowserKernel;directory?:string} = {host};
    active = state;
    const kernelWasm = options.kernel ? await (await fetch(options.origin+'/kernel.wasm')).arrayBuffer() : undefined;
    if (options.image) {
      // Transfer the HTTP body to a private OPFS file without retaining a
      // second whole disk in browser memory, then use normal positioned I/O.
      const root = await navigator.storage.getDirectory();
      const name = 'rust-debug-'+crypto.randomUUID();
      state.directory = name;
      const directory = await root.getDirectoryHandle(name,{create:true});
      const file = await directory.getFileHandle('image.vfs',{create:true});
      const response = await fetch(options.origin+'/image.vfs');
      if (!response.ok || !response.body) throw new Error('debug image fetch failed');
      await response.body.pipeTo(await file.createWritable());
      await host.initFromOpfsImage({kernelWasm,vfsImageFile:file});
    } else await host.initFromImage({kernelWasm,vfsImage:'default'});
    const program = await (await fetch(options.origin+'/program.wasm')).arrayBuffer();
    const exit = await host.spawn(program,options.argv,{env:options.env,stdin:new Uint8Array()});
    output('stdout'); output('stderr'); await outputDone;
    return exit;
}

export async function destroyRustBrowserDebuggee(): Promise<void> {
  const state = active;
  if (!state) return;
  try { await state.host.destroy(); }
  finally {
    active = undefined;
    if (state.directory) await (await navigator.storage.getDirectory()).removeEntry(state.directory,{recursive:true});
  }
}
