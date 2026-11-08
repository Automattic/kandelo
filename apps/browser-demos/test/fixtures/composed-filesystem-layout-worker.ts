// Keep the image writer and inspection buffers in a disposable worker, just
// like production composition. The test page receives metadata only.
import { composeKandeloImage } from "../../pages/kandelo/kernel-host/image-composer";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import { assertKandeloFilesystemLayout } from "../../../../images/vfs/scripts/filesystem-layout";
import { MARIADB_DATA_DIRS } from "../../../../images/vfs/scripts/mariadb-image-helpers";

self.onmessage = async ({ data }: MessageEvent<{ imageUrl: string }>) => {
  try {
    const response = await fetch(data.imageUrl);
    if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
    const composed = await composeKandeloImage({
      imageBytes: new Uint8Array(await response.arrayBuffer()),
      maxVfsByteLength: 768 * 1024 * 1024,
      imageLabel: "FHS composition regression",
      requestedProfileId: null,
      requestedProfileSource: null,
      hasCandidateEvidence: false,
      descriptor: { version: 1, boot: { inputs: [] } } as never,
      appPath: "/pages/kandelo/",
      proto: "http",
      preforkServiceProcesses: 1,
    }, () => {});
    const fs = KandeloImageFs.create();
    fs.loadImage(composed.imageBytes);
    assertKandeloFilesystemLayout(fs);
    const text = (path: string) => new TextDecoder().decode(fs.readFile(path));
    self.postMessage({
      profile: composed.profileId,
      helper: fs.stat("/usr/libexec/mariadb-ready"),
      helperSource: text("/usr/libexec/mariadb-ready"),
      service: text("/etc/dinit.d/mariadb-ready"),
      phpFpm: text("/etc/dinit.d/php-fpm"),
      directories: MARIADB_DATA_DIRS.map(path => ({ path, ...fs.stat(path) })),
    });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
