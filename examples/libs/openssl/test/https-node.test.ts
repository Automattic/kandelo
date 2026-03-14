import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";

const __dirname = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
    return execSync("git rev-parse --show-toplevel", {
        cwd: __dirname, encoding: "utf-8",
    }).trim();
}

/**
 * Network backend that delegates TCP operations to a worker thread.
 *
 * The kernel calls connect/send/recv/close synchronously (from Wasm imports).
 * These must block until the operation completes. Using Atomics.wait on the
 * main thread blocks the event loop, preventing async socket callbacks from
 * firing. This backend solves the problem by running socket operations in a
 * separate worker thread (which has its own event loop) and synchronizing
 * via SharedArrayBuffer + Atomics.
 *
 * Protocol:
 *   Main thread writes a command to shared memory, then Atomics.wait.
 *   Worker reads the command, performs the async operation, writes the result
 *   back, then Atomics.notify to wake the main thread.
 */
class WorkerTcpBackend {
    private worker: Worker;
    // Command buffer layout:
    //   Int32[0]: flag (0=idle, 1=command-ready, 2=result-ready, -1=error)
    //   Int32[1]: command (1=connect, 2=send, 3=recv, 4=close, 5=getaddrinfo)
    //   Int32[2]: handle
    //   Int32[3]: port / flags / maxLen
    //   Int32[4]: result length or error code
    // Data buffer: separate SAB for passing IP addresses, send/recv data, hostnames
    private cmdBuf: SharedArrayBuffer;
    private cmdView: Int32Array;
    private dataBuf: SharedArrayBuffer;
    private dataView: Uint8Array;

    constructor() {
        // 20 bytes for command metadata
        this.cmdBuf = new SharedArrayBuffer(32);
        this.cmdView = new Int32Array(this.cmdBuf);
        // 128KB for data transfer
        this.dataBuf = new SharedArrayBuffer(131072);
        this.dataView = new Uint8Array(this.dataBuf);

        const workerCode = `
const { parentPort } = require("node:worker_threads");
const net = require("net");
const dns = require("dns");

const connections = new Map();

parentPort.on("message", ({ cmdBuf, dataBuf }) => {
    const cmd = new Int32Array(cmdBuf);
    const data = new Uint8Array(dataBuf);

    function loop() {
        // Wait for a command from the main thread
        Atomics.wait(cmd, 0, 0);  // wait until flag != 0
        // Also handle case where flag is already 2 (stale)
        if (cmd[0] !== 1) {
            // Not a command, reset and re-wait
            if (cmd[0] === 2) Atomics.store(cmd, 0, 0);
            setImmediate(loop);
            return;
        }

        const command = cmd[1];
        const handle = cmd[2];
        const param = cmd[3]; // port, flags, or maxLen

        switch (command) {
            case 5: { // getaddrinfo
                const nameLen = param;
                const hostname = Buffer.from(data.slice(0, nameLen)).toString("utf-8");
                dns.lookup(hostname, 4, (err, address) => {
                    if (err || !address) {
                        cmd[4] = -1;
                        Atomics.store(cmd, 0, -1);
                    } else {
                        const parts = address.split(".").map(Number);
                        data[0] = parts[0]; data[1] = parts[1];
                        data[2] = parts[2]; data[3] = parts[3];
                        cmd[4] = 4;
                        Atomics.store(cmd, 0, 2);
                    }
                    Atomics.notify(cmd, 0);
                    setImmediate(loop);
                });
                break;
            }
            case 1: { // connect
                const ip = data[0] + "." + data[1] + "." + data[2] + "." + data[3];
                const port = param;
                const socket = new net.Socket();
                const conn = { socket, recvBuf: Buffer.alloc(0), closed: false };

                socket.on("data", (chunk) => {
                    conn.recvBuf = Buffer.concat([conn.recvBuf, chunk]);
                });
                socket.on("close", () => { conn.closed = true; });

                socket.connect(port, ip, () => {
                    connections.set(handle, conn);
                    cmd[4] = 0;
                    Atomics.store(cmd, 0, 2);
                    Atomics.notify(cmd, 0);
                    setImmediate(loop);
                });
                socket.once("error", (err) => {
                    cmd[4] = -1;
                    Atomics.store(cmd, 0, -1);
                    Atomics.notify(cmd, 0);
                    setImmediate(loop);
                });
                break;
            }
            case 2: { // send
                const conn = connections.get(handle);
                if (!conn) {
                    cmd[4] = -1;
                    Atomics.store(cmd, 0, -1);
                    Atomics.notify(cmd, 0);
                    setImmediate(loop);
                    break;
                }
                const len = param;
                const sendData = Buffer.from(data.slice(0, len));
                conn.socket.write(sendData, () => {
                    cmd[4] = len;
                    Atomics.store(cmd, 0, 2);
                    Atomics.notify(cmd, 0);
                    setImmediate(loop);
                });
                break;
            }
            case 3: { // recv
                const conn = connections.get(handle);
                if (!conn) {
                    cmd[4] = -1;
                    Atomics.store(cmd, 0, -1);
                    Atomics.notify(cmd, 0);
                    setImmediate(loop);
                    break;
                }
                const maxLen = param;
                function tryRecv() {
                    if (conn.recvBuf.length > 0) {
                        const n = Math.min(maxLen, conn.recvBuf.length);
                        data.set(conn.recvBuf.subarray(0, n), 0);
                        conn.recvBuf = conn.recvBuf.subarray(n);
                        cmd[4] = n;
                        Atomics.store(cmd, 0, 2);
                        Atomics.notify(cmd, 0);
                        setImmediate(loop);
                    } else if (conn.closed) {
                        cmd[4] = 0;
                        Atomics.store(cmd, 0, 2);
                        Atomics.notify(cmd, 0);
                        setImmediate(loop);
                    } else {
                        // Wait for data
                        const onData = () => {
                            conn.socket.removeListener("close", onClose);
                            tryRecv();
                        };
                        const onClose = () => {
                            conn.socket.removeListener("data", onData);
                            tryRecv();
                        };
                        conn.socket.once("data", onData);
                        conn.socket.once("close", onClose);
                    }
                }
                tryRecv();
                break;
            }
            case 4: { // close
                const conn = connections.get(handle);
                if (conn) {
                    conn.socket.destroy();
                    connections.delete(handle);
                }
                cmd[4] = 0;
                Atomics.store(cmd, 0, 2);
                Atomics.notify(cmd, 0);
                setImmediate(loop);
                break;
            }
            default: {
                cmd[4] = -1;
                Atomics.store(cmd, 0, -1);
                Atomics.notify(cmd, 0);
                setImmediate(loop);
            }
        }
    }

    loop();
});
`;

        this.worker = new Worker(workerCode, { eval: true });
        this.worker.postMessage({ cmdBuf: this.cmdBuf, dataBuf: this.dataBuf });
    }

    private execCommand(command: number, handle: number, param: number, timeoutMs = 30000): number {
        Atomics.store(this.cmdView, 1, command);
        Atomics.store(this.cmdView, 2, handle);
        Atomics.store(this.cmdView, 3, param);
        Atomics.store(this.cmdView, 4, 0);
        // Signal command ready
        Atomics.store(this.cmdView, 0, 1);
        Atomics.notify(this.cmdView, 0);

        // Wait for result
        const result = Atomics.wait(this.cmdView, 0, 1, timeoutMs);
        const flag = Atomics.load(this.cmdView, 0);
        const retVal = this.cmdView[4];

        // Reset to idle
        Atomics.store(this.cmdView, 0, 0);

        if (flag === -1) throw new Error("Operation failed");
        if (flag !== 2 && result === "timed-out") throw new Error("Operation timed out");
        return retVal;
    }

    getaddrinfo(hostname: string): Uint8Array {
        const encoded = new TextEncoder().encode(hostname);
        this.dataView.set(encoded, 0);
        this.execCommand(5, 0, encoded.length, 10000);
        return new Uint8Array([this.dataView[0], this.dataView[1], this.dataView[2], this.dataView[3]]);
    }

    connect(handle: number, addr: Uint8Array, port: number): void {
        this.dataView[0] = addr[0];
        this.dataView[1] = addr[1];
        this.dataView[2] = addr[2];
        this.dataView[3] = addr[3];
        this.execCommand(1, handle, port, 30000);
    }

    send(handle: number, data: Uint8Array, flags: number): number {
        this.dataView.set(data, 0);
        return this.execCommand(2, handle, data.length);
    }

    recv(handle: number, maxLen: number, flags: number): Uint8Array {
        const n = this.execCommand(3, handle, maxLen, 30000);
        if (n <= 0) return new Uint8Array(0);
        return new Uint8Array(this.dataView.slice(0, n));
    }

    close(handle: number): void {
        this.execCommand(4, handle, 0);
    }

    terminate(): void {
        this.worker.terminate();
    }
}

describe("HTTPS GET via OpenSSL over real TCP", () => {
    it("performs a full TLS handshake and HTTP GET to example.com", async () => {
        const root = repoRoot();
        const { WasmPosixKernel } = await import(join(root, "host/src/kernel.ts"));
        const { ProgramRunner } = await import(join(root, "host/src/program-runner.ts"));
        const { NodePlatformIO } = await import(join(root, "host/src/platform/node.ts"));

        const kernelWasm = readFileSync(join(root, "host/wasm/wasm_posix_kernel.wasm"));
        const programWasm = readFileSync(join(__dirname, "https_get.wasm"));

        let stdout = "";
        let stderr = "";
        const io = new NodePlatformIO();
        const backend = new WorkerTcpBackend();
        (io as any).network = backend;

        const kernel = new WasmPosixKernel(
            { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: false },
            io,
            {
                onStdout: (data: Uint8Array) => { stdout += new TextDecoder().decode(data); },
                onStderr: (data: Uint8Array) => { stderr += new TextDecoder().decode(data); },
            },
        );

        try {
            await kernel.init(kernelWasm);

            const runner = new ProgramRunner(kernel);
            const exitCode = await runner.run(programWasm, {
                argv: ["https_get", "example.com"],
            });

            // Log output for debugging if something goes wrong
            if (exitCode !== 0) {
                console.log("STDOUT:", stdout);
                console.log("STDERR:", stderr);
            }

            expect(stdout).toContain("OK: connected to example.com:443");
            expect(stdout).toContain("OK: TLS handshake complete");
            expect(stdout).toContain("OK: response: HTTP/1.1");
            expect(stdout).toContain("PASS");
            expect(exitCode).toBe(0);
        } finally {
            backend.terminate();
        }
    }, 60_000);
});
