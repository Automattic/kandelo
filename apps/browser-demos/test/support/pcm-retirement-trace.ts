import type { BrowserContext } from "@playwright/test";

export async function installPcmRetirementTrace(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const NativeNode = globalThis.AudioWorkletNode;
    if (typeof NativeNode !== "function") return;
    let nextId = 0;
    const observe = (port: MessagePort, context: AudioContext) => {
      const id = ++nextId;
      const emit = (event: string) => {
        console.log("pcm-retirement-trace " + JSON.stringify({ id, event, at: Date.now(),
          contextState: context.state, contextTime: context.currentTime }));
      };
      const post = port.postMessage.bind(port);
      port.postMessage = (message: unknown, ...rest: any[]) => {
        if ((message as { type?: string })?.type === "detach") emit("detach-request");
        Reflect.apply(post, port, [message, ...rest]);
      };
      port.addEventListener("message", event => {
        if (event.data?.type === "detached") emit("detach-ack");
      });
      const close = port.close.bind(port);
      port.close = () => {
        emit("port-close");
        close();
      };
      emit("bind");
    };
    globalThis.AudioWorkletNode = class extends NativeNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name === "kandelo-pcm-output") {
          observe(this.port, context as AudioContext);
        }
      }
    };
  });
}
