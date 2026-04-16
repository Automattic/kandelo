/**
 * SystemInit — orchestrates browser demo boot from /etc/init.d/ service
 * descriptors in the VFS.
 *
 * Reads service descriptors, resolves dependencies, sets up the HTTP bridge
 * if needed, and spawns each service in order. Supports daemon, oneshot,
 * and interactive (PTY) service types.
 */
import type { BrowserKernel } from "../browser-kernel";
import { HttpBridgeHost } from "../http-bridge";
import { PtyTerminal, type PtyTerminalOptions } from "../pty-terminal";
import { TerminalPanel } from "../terminal-panel";
import {
  parseServiceDescriptor,
  type ServiceDescriptor,
} from "./service-descriptor";
import { initServiceWorkerBridge } from "./service-worker-bridge";

const decoder = new TextDecoder();

export interface SystemInitOptions {
  onLog?: (message: string, level: "info" | "stderr" | "error") => void;
  onServiceReady?: (name: string, pid: number) => void;
  terminalContainer?: HTMLElement | null;
  serviceWorkerUrl?: string;
  appPrefix?: string;
  ptyOptions?: PtyTerminalOptions;
  onBeforeService?: (
    name: string,
    descriptor: ServiceDescriptor,
  ) => Promise<void>;
}

interface RunningService {
  descriptor: ServiceDescriptor;
  pid: number;
  exitPromise: Promise<number>;
}

export class SystemInit {
  private kernel: BrowserKernel;
  private options: SystemInitOptions;
  private services = new Map<string, RunningService>();
  private readyServices = new Set<string>();
  private terminalPanel: TerminalPanel | null = null;
  private ptyTerminal: PtyTerminal | null = null;
  private bridgeHttpPort: number | null = null;
  private bridgeRestoreCleanup: (() => void) | null = null;

  constructor(kernel: BrowserKernel, options?: SystemInitOptions) {
    this.kernel = kernel;
    this.options = options ?? {};
  }

  /**
   * Boot the system: read /etc/init.d/, parse descriptors, and start
   * all services in dependency order.
   */
  async boot(): Promise<void> {
    const descriptors = this.readServiceDescriptors();

    if (descriptors.length === 0) {
      this.log("No services found in /etc/init.d/", "info");
      return;
    }

    // Sort by order (numeric prefix from filename)
    descriptors.sort((a, b) => a.order - b.order);

    // Check if any service needs the HTTP bridge
    const bridgePort = descriptors.find((d) => d.bridge != null)?.bridge;
    if (bridgePort != null) {
      const swUrl =
        this.options.serviceWorkerUrl ?? "/demo/service-worker.js";
      const appPrefix = this.options.appPrefix ?? "/demo/app/";
      this.log("Initializing service worker bridge...", "info");
      const bridge = await initServiceWorkerBridge(swUrl, appPrefix);
      if (bridge) {
        this.kernel.sendBridgePort(bridge.detachHostPort(), bridgePort);
        this.bridgeHttpPort = bridgePort ?? null;
        this.log(`HTTP bridge ready on port ${bridgePort}`, "info");
        this.setupBridgeRestoreListener();
      } else {
        this.log(
          "Service workers unavailable — HTTP bridge not initialized",
          "error",
        );
      }
    }

    // Start each service in order
    for (const descriptor of descriptors) {
      await this.startService(descriptor);
    }
  }

  /**
   * Shut down all running services in reverse start order.
   */
  async shutdown(): Promise<void> {
    const entries = [...this.services.values()].reverse();
    for (const svc of entries) {
      this.log(`Stopping ${svc.descriptor.name} (pid ${svc.pid})...`, "info");
      try {
        await this.kernel.terminateProcess(svc.pid);
      } catch {
        // Process may have already exited
      }
    }
    this.services.clear();
    this.readyServices.clear();

    if (this.bridgeRestoreCleanup) {
      this.bridgeRestoreCleanup();
      this.bridgeRestoreCleanup = null;
    }

    if (this.ptyTerminal) {
      this.ptyTerminal.dispose();
      this.ptyTerminal = null;
    }
    if (this.terminalPanel) {
      this.terminalPanel.dispose();
      this.terminalPanel = null;
    }
  }

  /**
   * Listen for "need-bridge" messages from a restarted service worker.
   * When the browser terminates and restarts the SW, it loses its bridge
   * MessagePort. The SW detects this and asks a client page to create a
   * new bridge. We respond by creating a new HttpBridgeHost and sending
   * one port to the SW and the other to the kernel worker.
   */
  private setupBridgeRestoreListener(): void {
    if (!("serviceWorker" in navigator)) return;

    const appPrefix = this.options.appPrefix ?? "/demo/app/";

    const handler = (event: MessageEvent) => {
      if (event.data?.type !== "need-bridge") return;
      const replyPort = event.ports[0];
      if (!replyPort) return;

      const bridge = new HttpBridgeHost();

      // Send SW port back to the service worker via reply channel
      replyPort.postMessage(
        { type: "bridge-restored", appPrefix },
        [bridge.getSwPort()],
      );

      // Send host port to the kernel worker
      this.kernel.sendBridgePort(
        bridge.detachHostPort(),
        this.bridgeHttpPort ?? undefined,
      );

      this.log("Bridge restored after service worker restart", "info");
    };

    navigator.serviceWorker.addEventListener("message", handler);
    this.bridgeRestoreCleanup = () => {
      navigator.serviceWorker.removeEventListener("message", handler);
    };
  }

  /** Get the PtyTerminal instance (if an interactive service was started). */
  getPtyTerminal(): PtyTerminal | null {
    return this.ptyTerminal;
  }

  /** Get the TerminalPanel instance (if an interactive service was started). */
  getTerminalPanel(): TerminalPanel | null {
    return this.terminalPanel;
  }

  /** Get a running service by name. */
  getService(name: string): RunningService | undefined {
    return this.services.get(name);
  }

  // ── Private helpers ──

  /**
   * Read and parse all service descriptors from /etc/init.d/.
   */
  private readServiceDescriptors(): ServiceDescriptor[] {
    const fs = this.kernel.fs;
    const descriptors: ServiceDescriptor[] = [];

    let dirHandle: number;
    try {
      dirHandle = fs.opendir("/etc/init.d");
    } catch {
      // /etc/init.d/ doesn't exist — no services
      return [];
    }

    try {
      let entry = fs.readdir(dirHandle);
      while (entry !== null) {
        if (entry.name !== "." && entry.name !== "..") {
          try {
            const content = this.readTextFromVfs(`/etc/init.d/${entry.name}`);
            descriptors.push(parseServiceDescriptor(entry.name, content));
          } catch (e) {
            this.log(
              `Failed to parse /etc/init.d/${entry.name}: ${e}`,
              "error",
            );
          }
        }
        entry = fs.readdir(dirHandle);
      }
    } finally {
      fs.closedir(dirHandle);
    }

    return descriptors;
  }

  /**
   * Start a single service based on its descriptor.
   */
  private async startService(descriptor: ServiceDescriptor): Promise<void> {
    const { name } = descriptor;

    // Fire the onBeforeService callback
    if (this.options.onBeforeService) {
      await this.options.onBeforeService(name, descriptor);
    }

    // Wait for dependencies
    if (descriptor.depends) {
      for (const dep of descriptor.depends) {
        await this.waitForService(dep, name);
      }
    }

    this.log(`Starting ${name}...`, "info");

    // Read the binary from VFS
    const binaryPath = descriptor.command[0];
    let programBytes: ArrayBuffer;
    try {
      programBytes = await this.readBinaryFromVfs(binaryPath);
    } catch (e) {
      this.log(`Failed to read binary ${binaryPath}: ${e}`, "error");
      return;
    }

    const spawnOptions: {
      env?: string[];
      cwd?: string;
      stdin?: Uint8Array;
      pty?: boolean;
    } = {};
    if (descriptor.env) {
      spawnOptions.env = descriptor.env;
    }
    if (descriptor.cwd) {
      spawnOptions.cwd = descriptor.cwd;
    }

    switch (descriptor.type) {
      case "daemon":
        await this.startDaemon(descriptor, programBytes, spawnOptions);
        break;
      case "oneshot":
        await this.startOneshot(descriptor, programBytes, spawnOptions);
        break;
      case "interactive":
        await this.startInteractive(descriptor, programBytes, spawnOptions);
        break;
    }
  }

  /**
   * Start a daemon service: spawn, wait for readiness, log exit on completion.
   */
  private async startDaemon(
    descriptor: ServiceDescriptor,
    programBytes: ArrayBuffer,
    spawnOptions: { env?: string[]; cwd?: string },
  ): Promise<void> {
    const { name, command } = descriptor;

    const exitPromise = this.kernel.spawn(programBytes, command, spawnOptions);
    const pid = (this.kernel as any).nextPid - 1;

    this.services.set(name, { descriptor, pid, exitPromise });

    // Log when the daemon exits
    exitPromise.then((code) => {
      this.log(`${name} (pid ${pid}) exited with code ${code}`, "info");
    });

    // Wait for readiness
    await this.waitForReady(descriptor, pid);

    this.readyServices.add(name);
    this.log(`${name} ready (pid ${pid})`, "info");
    this.options.onServiceReady?.(name, pid);
  }

  /**
   * Start a oneshot service: spawn with optional stdin, wait for readiness,
   * optionally terminate after ready.
   */
  private async startOneshot(
    descriptor: ServiceDescriptor,
    programBytes: ArrayBuffer,
    spawnOptions: { env?: string[]; cwd?: string; stdin?: Uint8Array },
  ): Promise<void> {
    const { name, command } = descriptor;

    // Read stdin from VFS if specified
    if (descriptor.stdin) {
      try {
        const stdinContent = this.readTextFromVfs(descriptor.stdin);
        spawnOptions.stdin = new TextEncoder().encode(stdinContent);
      } catch (e) {
        this.log(`Failed to read stdin file ${descriptor.stdin}: ${e}`, "error");
      }
    }

    const exitPromise = this.kernel.spawn(programBytes, command, spawnOptions);
    const pid = (this.kernel as any).nextPid - 1;

    this.services.set(name, { descriptor, pid, exitPromise });

    // Wait for readiness
    await this.waitForReady(descriptor, pid);

    // Terminate if configured
    if (descriptor.terminate) {
      try {
        await this.kernel.terminateProcess(pid);
      } catch {
        // May have already exited
      }
    }

    this.readyServices.add(name);
    this.log(`${name} ready (pid ${pid})`, "info");
    this.options.onServiceReady?.(name, pid);
  }

  /**
   * Start an interactive service: create TerminalPanel + PtyTerminal,
   * spawn with PTY, and connect I/O.
   */
  private async startInteractive(
    descriptor: ServiceDescriptor,
    programBytes: ArrayBuffer,
    spawnOptions: { env?: string[]; cwd?: string },
  ): Promise<void> {
    const { name, command } = descriptor;

    // Create terminal panel if we have a container
    if (this.options.terminalContainer && !this.terminalPanel) {
      this.terminalPanel = new TerminalPanel(this.options.terminalContainer);
    }

    // Determine the container for xterm.js
    const xtermContainer = this.terminalPanel
      ? this.terminalPanel.getTerminalContainer()
      : this.options.terminalContainer;

    if (!xtermContainer) {
      this.log(
        `No terminal container for interactive service ${name}`,
        "error",
      );
      return;
    }

    // Create PtyTerminal
    const ptyTerminal = new PtyTerminal(
      xtermContainer,
      this.kernel,
      this.options.ptyOptions,
    );
    this.ptyTerminal = ptyTerminal;

    // Connect panel expand → terminal fit
    if (this.terminalPanel) {
      this.terminalPanel.onExpand(() => ptyTerminal.fit());
    }

    // Spawn with PTY
    const exitPromise = ptyTerminal.spawn(programBytes, command, spawnOptions);
    const pid = (this.kernel as any).nextPid - 1;

    this.services.set(name, { descriptor, pid, exitPromise });

    // Wait for readiness
    await this.waitForReady(descriptor, pid);

    this.readyServices.add(name);
    this.log(`${name} ready (pid ${pid})`, "info");
    this.options.onServiceReady?.(name, pid);

    // Update terminal panel status
    if (this.terminalPanel) {
      this.terminalPanel.setStatus(`${name} ready`);
    }
  }

  /**
   * Wait for a named service to be in the ready set.
   */
  private async waitForService(
    depName: string,
    waiterName: string,
  ): Promise<void> {
    if (this.readyServices.has(depName)) {
      return;
    }
    this.log(`${waiterName} waiting for ${depName}...`, "info");
    // Poll until the dependency is ready (checked every 100ms)
    while (!this.readyServices.has(depName)) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Wait for a service to be ready according to its ready condition.
   */
  private async waitForReady(
    descriptor: ServiceDescriptor,
    pid: number,
  ): Promise<void> {
    const ready = descriptor.ready;
    if (!ready) {
      // No ready condition — immediately ready
      return;
    }

    switch (ready.kind) {
      case "port":
        await this.waitForPort(ready.port, descriptor.name);
        break;
      case "delay":
        await new Promise((r) => setTimeout(r, ready.ms));
        break;
      case "exit":
        await this.waitForExit(descriptor.name);
        break;
      case "stdin-consumed":
        await this.waitForStdinConsumed(pid, descriptor.name);
        break;
    }
  }

  /**
   * Poll pickListenerTarget until a listener appears on the given port.
   * Up to 60 attempts, 1 second apart.
   */
  private async waitForPort(port: number, name: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const target = await this.kernel.pickListenerTarget(port);
      if (target) {
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.log(
      `${name}: timed out waiting for listener on port ${port}`,
      "error",
    );
  }

  /**
   * Wait for a service's process to exit.
   */
  private async waitForExit(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (svc) {
      await svc.exitPromise;
    }
  }

  /**
   * Poll isStdinConsumed until the process has consumed its stdin.
   * Up to 1200 attempts (600s), 500ms apart, plus a 2s grace period.
   */
  private async waitForStdinConsumed(
    pid: number,
    name: string,
  ): Promise<void> {
    for (let i = 0; i < 1200; i++) {
      try {
        const consumed = await this.kernel.isStdinConsumed(pid);
        if (consumed) {
          // Grace period for the process to finish processing
          await new Promise((r) => setTimeout(r, 2000));
          return;
        }
      } catch {
        // Process may have exited
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.log(`${name}: timed out waiting for stdin to be consumed`, "error");
  }

  /**
   * Read a binary file from the VFS, following symlinks.
   * Materializes lazy files (fetching content from URL) before reading.
   */
  private async readBinaryFromVfs(path: string): Promise<ArrayBuffer> {
    const fs = this.kernel.fs;

    // Materialize lazy files (empty stubs with URL metadata) before reading
    await fs.ensureMaterialized(path);

    // Try to follow symlinks
    let resolvedPath = path;
    try {
      resolvedPath = fs.readlink(path);
    } catch {
      // Not a symlink — use original path
    }

    const fd = fs.open(resolvedPath, 0 /* O_RDONLY */, 0);
    try {
      const stat = fs.fstat(fd);
      const buf = new Uint8Array(stat.size);
      fs.read(fd, buf, 0, buf.length);
      return buf.buffer;
    } finally {
      fs.close(fd);
    }
  }

  /**
   * Read a text file from the VFS.
   */
  private readTextFromVfs(path: string): string {
    const fs = this.kernel.fs;
    let resolvedPath = path;
    try { resolvedPath = fs.readlink(path); } catch { /* not a symlink */ }
    const fd = fs.open(resolvedPath, 0 /* O_RDONLY */, 0);
    try {
      const stat = fs.fstat(fd);
      const buf = new Uint8Array(stat.size);
      fs.read(fd, buf, 0, buf.length);
      return decoder.decode(buf);
    } finally {
      fs.close(fd);
    }
  }

  /**
   * Log a message via the onLog callback.
   */
  private log(message: string, level: "info" | "stderr" | "error"): void {
    this.options.onLog?.(message, level);
  }
}
