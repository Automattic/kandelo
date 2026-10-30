import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { httpRetirementImage } from "./fixtures/http-retirement-image";
import { exerciseHttpRetirement, HttpRetirementTranscript } from "./fixtures/http-retirement-workload";

test("persistent Node HTTP timeout waves retire only host and unaccepted owners", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-http-retirement-"));
  const transcript = new HttpRetirementTranscript();
  let host: NodeKernelHost | undefined;
  let closed = true;
  try {
    const image = await httpRetirementImage(directory);
    host = new NodeKernelHost({ rootfsImageFile: image.path, rootfsPersistentImageBinding: image.binding,
      experimentalResizablePersistencePath: join(directory, "journal"),
      kernelMaxPages: 1024, maxWorkers: 1, maxPages: 1024,
      onStdout: (_pid, bytes) => transcript.append(bytes), onStderr: (_pid, bytes) => transcript.append(bytes) });
    closed = false;
    await host.init();
    const process = await host.spawnFromVfs("/bin/http-retirement", ["http-retirement", "8097"], {
      onStarted: () => {},
    });
    await transcript.waitFor("RETIREMENT_READY");
    const observations = await exerciseHttpRetirement(host, process.pid, transcript, 8097);
    expect(await process.exit).toBe(0);
    expect(observations.waves).toBe(12);
    console.info(`http retirement ${JSON.stringify(observations)}`);
    await host.destroy();
    expect(host.getPersistenceShutdownFailure()).toBeNull();
    closed = true;
    host = undefined;
  } catch (error) {
    if (error !== null && typeof error === "object" && (error as { retainTarget?: boolean }).retainTarget) closed = false;
    throw error;
  } finally {
    if (host !== undefined) {
      await host.destroy();
      closed = host.getPersistenceShutdownFailure() === null;
    }
    if (closed) rmSync(directory, { recursive: true, force: true });
    else console.error(`Retained HTTP retirement storage after uncertain close: ${directory}`);
  }
}, 120000);
