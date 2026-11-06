import type { HttpRequest, HttpResponse } from "../../src/networking/in-kernel-http";
import { parseFilesystemMemory } from "./filesystem-memory";

interface RetirementClient {
  fetchInKernel(port: number, request: HttpRequest, options: { timeoutMs: number }): Promise<HttpResponse>;
  appendStdinData(pid: number, bytes: Uint8Array): void;
}

export class HttpRetirementTranscript {
  text = "";
  private waiters = new Set<() => void>();

  append(bytes: Uint8Array): void {
    this.text += new TextDecoder().decode(bytes);
    if (this.text.length > 131072) throw new Error("HTTP retirement transcript exceeds its bound");
    for (const check of [...this.waiters]) check();
  }

  waitFor(marker: string, offset = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`HTTP retirement guest did not report ${marker}: ${this.text.slice(offset)}`));
      }, 20000);
      const check = () => {
        const output = this.text.slice(offset);
        if (!output.includes(marker)) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(output);
      };
      this.waiters.add(check);
      check();
    });
  }
}

export async function exerciseHttpRetirement(client: RetirementClient, pid: number,
  transcript: HttpRetirementTranscript, port: number) {
  const command = async (input: string, marker: string) => {
    const output = transcript.waitFor(marker, transcript.text.length);
    client.appendStdinData(pid, new TextEncoder().encode(input));
    return output;
  };
  const memory = async (stage: string) => ({ stage,
    admission: parseFilesystemMemory(await command("m", "FS_MEMORY_END")) });
  await transcript.waitFor("RETIREMENT_READY");
  const observations = [await memory("initial")];
  for (let wave = 0; wave < 12; wave++) {
    const responses = await Promise.all(Array.from({ length: 12 }, (_, request) => client.fetchInKernel(port,
      { method: "GET", url: `/waiting-${wave}-${request}`, headers: {}, body: null }, { timeoutMs: 30 })));
    if (responses.some(response => response.status !== 504)) throw new Error("Expected an unaccepted HTTP timeout");
    await command("a", "ACCEPT_EMPTY");
    observations.push(await memory(`unaccepted-wave-${wave}`));
  }
  const baseline = observations[1].admission.owners.io.live;
  if (observations.slice(1).some(sample => sample.admission.owners.io.live !== baseline)) {
    throw new Error(`Timed-out unaccepted HTTP work retains I/O credits: ${JSON.stringify(observations)}`);
  }
  const accepted = client.fetchInKernel(port, { method: "GET", url: "/accepted", headers: {}, body: null }, { timeoutMs: 1000 });
  await command("a", "ACCEPTED");
  if ((await accepted).status !== 504) throw new Error("Expected an accepted HTTP timeout");
  observations.push(await memory("accepted-owner-retained"));
  if (observations.at(-1)!.admission.owners.io.live < baseline + 4 * 65536) {
    throw new Error("Timeout discarded the accepted guest's pipe ownership");
  }
  await command("v", "PEER_RESET");
  observations.push(await memory("accepted-owner-closed"));
  if (observations.at(-1)!.admission.owners.io.live >= baseline + 65536) {
    throw new Error("Accepted guest close did not release pipe payload ownership");
  }
  const served = client.fetchInKernel(port, { method: "GET", url: "/available", headers: {}, body: null }, { timeoutMs: 5000 });
  await command("a", "ACCEPTED");
  await command("s", "SERVED");
  const response = await served;
  if (response.status !== 200 || new TextDecoder().decode(response.body) !== "ok") {
    throw new Error("HTTP service did not recover after timeout pressure");
  }
  client.appendStdinData(pid, new TextEncoder().encode("q"));
  return { observations, waves: 12, requestsPerWave: 12 };
}
