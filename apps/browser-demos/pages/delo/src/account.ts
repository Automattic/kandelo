// The account the first process of a delo computer runs as. The disk builder
// starts it as root, uid 0 and gid 0; its name is the one that the
// /etc/passwd an installed package adds gives that uid.

import type { DeloPipeline } from "./registry";

export const DELO_FIRST_PROCESS_ACCOUNT = { uid: 0, gid: 0 } as const;

/** The name `/etc/passwd` in `packages` gives `uid`, or `uid <n>` when none does. */
export function deloAccountName(packages: readonly Pick<DeloPipeline, "files">[], uid: number): string {
  for (const file of packages.flatMap((entry) => entry.files)) {
    const text = "content" in file ? file.content : undefined;
    if (file.to !== "/etc/passwd" || text === undefined) continue;
    const account = text.split("\n").map((line) => line.split(":")).find((fields) => fields[2] === String(uid));
    if (account !== undefined) return account[0];
  }
  return `uid ${uid}`;
}
