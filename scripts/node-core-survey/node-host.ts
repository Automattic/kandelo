import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { NodeKernelHost, type NodeKernelHostOptions } from "../../host/src/node-kernel-host";
import { runGuestShard } from "./guest-shard";
import { fileDigest, loadInputs, loadPeerFixtures, writeGuestReport } from "./inputs";
import { runPeerHttps } from "./peer-https";

const readinessStartedAt = performance.now();
const lazyAssetDirectory = "https://node-core-survey.invalid/";

const [outputPath, preparedPath, peerMode, extra] = process.argv.slice(2);
if (!outputPath || !preparedPath || (peerMode && peerMode !== "--peer") || extra) {
  throw new Error("Usage: node-host.ts <new report directory> <prepared directory | --preflight | certificate directory --peer>");
}
const report = resolve(outputPath);
mkdirSync(report);
const preflightOnly = preparedPath === "--preflight";
try {
  const { identity, image, kernel, assets, shard } = loadInputs(peerMode ? "--preflight" : preparedPath, lazyAssetDirectory);
  const peer = peerMode ? loadPeerFixtures(preparedPath) : undefined;
  writeFileSync(join(report, "inputs.json"), JSON.stringify({
    ...identity, host: "Node", version: process.version, platform: process.platform, arch: process.arch,
    peerFixturesSha256: peer?.fixtureSha256,
    harnessSha256: { ...identity.harnessSha256, "node-host.ts": fileDigest("node-host.ts"),
      ...(peer && { "peer-https.ts": fileDigest("peer-https.ts") }) },
  }, null, 2) + "\n");
  const createHost = (options: NodeKernelHostOptions) => new NodeKernelHost({
    ...options, rootfsLazyAssetDirectory: lazyAssetDirectory, rootfsLazyAssets: assets,
  });
  if (peer) {
    const result = await runPeerHttps(createHost, image, kernel.bytes, peer.fixtures, readinessStartedAt);
    writeFileSync(join(report, "peer-https.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ report, failure: result.failure, teardown: result.teardown }));
    if (result.failure || result.teardown.some(reason => reason !== null)) process.exitCode = 1;
  } else {
    const result = await runGuestShard(createHost, { image, kernel: kernel.bytes, shard, readinessStartedAt });
    writeGuestReport(report, result);
    const upstreamExit = result.invocations.find(row => row.phase === "upstream-runner")?.exitStatus;
    console.log(JSON.stringify({ report, outcome: result.outcome, upstreamExit, error: result.error }));
    if (result.outcome !== "finished" || result.teardownError || result.diagnostics.length ||
        (!preflightOnly && upstreamExit !== 0)) process.exitCode = 1;
  }
} catch (error) {
  writeFileSync(join(report, "setup-error.txt"), String(error) + "\n");
  throw error;
}
