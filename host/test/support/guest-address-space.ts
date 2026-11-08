export const GUEST_ADDRESS_PHASES = [
  "ready", "reserved", "anonymous", "fixed", "remapped", "file", "rejected",
] as const;

interface ProbeHost {
  spawn(bytes: ArrayBuffer, argv: string[], options: { onStarted(pid: number): void }): Promise<number>;
  getKernelMemoryPages(): Promise<number>;
  enumProcs(): Promise<Array<{ pid: number; memoryBytes?: number }>>;
  appendStdinData(pid: number, bytes: Uint8Array): void;
}

/** Real guest operations stop at stdin while the host observes their result. */
export class GuestAddressSpaceProbe {
  stdout = "";
  private pendingLine = "";
  private host!: ProbeHost;
  private pid!: Promise<number>;
  private samples = Promise.resolve();
  readonly errors: string[] = [];
  readonly phases: Array<{ name: string; kernelBytes: number; processBytes: number }> = [];

  onStdout(bytes: Uint8Array): void {
    const text = new TextDecoder().decode(bytes);
    this.stdout += text;
    this.pendingLine += text;
    while (this.pendingLine.includes("\n")) {
      const end = this.pendingLine.indexOf("\n");
      const line = this.pendingLine.slice(0, end);
      this.pendingLine = this.pendingLine.slice(end + 1);
      if (!line.startsWith("MEMORY PHASE ")) continue;
      const name = line.slice("MEMORY PHASE ".length);
      this.samples = this.samples.then(async () => {
        const pid = await this.pid;
        try {
          const [pages, processes] = await Promise.all([
            this.host.getKernelMemoryPages(), this.host.enumProcs(),
          ]);
          const processBytes = processes.find(process => process.pid === pid)?.memoryBytes;
          if (processBytes === undefined) throw new Error(`Missing process ${pid} memory`);
          this.phases.push({ name, kernelBytes: pages * 65_536, processBytes });
        } catch (error) {
          this.errors.push(String(error));
        } finally {
          this.host.appendStdinData(pid, Uint8Array.of(120));
        }
      });
    }
  }

  async run(host: ProbeHost, program: ArrayBuffer) {
    this.host = host;
    let started!: (pid: number) => void;
    this.pid = new Promise(resolve => { started = resolve; });
    const exitCode = await host.spawn(program, ["guest-address-space"], { onStarted: started });
    await this.samples;
    return { exitCode, stdout: this.stdout, phases: this.phases, errors: this.errors };
  }
}
