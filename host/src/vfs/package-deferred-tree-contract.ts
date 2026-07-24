import type { LazyTreeActivation } from "./memory-fs";
import { VFS_DEFERRED_TREE_LIMITS } from "./deferred-tree-limits";

const MAX_OWNER_ID = 0xffff_fffe;
const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9+._-]*$/;
const OUTPUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/;
const TREE_ID_RE = /^[a-z0-9][a-z0-9+._/-]*$/;
const textEncoder = new TextEncoder();

export interface PackageDeferredZipTreeSpec {
  schema: 1;
  kind: "kandelo-package-deferred-zip-tree";
  id: string;
  /** Distribution meaning; source trees are not package/bottle payloads. */
  content_role: "source-tree" | "runtime-tree";
  package: {
    name: string;
    output: string;
  };
  archive: {
    url: string;
    mode_policy: "portable-posix-v1";
  };
  mount_prefix: string;
  owner: {
    uid: number;
    gid: number;
  };
  activation: LazyTreeActivation;
}

/** Parse the reviewable recipe without trusting unknown fields or host paths. */
export function parsePackageDeferredZipTreeSpec(
  value: unknown,
): PackageDeferredZipTreeSpec {
  const record = exactRecord(value, [
    "schema",
    "kind",
    "id",
    "content_role",
    "package",
    "archive",
    "mount_prefix",
    "owner",
    "activation",
  ], "package deferred ZIP tree spec");
  const packageRecord = exactRecord(
    record.package,
    ["name", "output"],
    "package deferred ZIP tree package",
  );
  const archive = exactRecord(
    record.archive,
    ["url", "mode_policy"],
    "package deferred ZIP tree archive",
  );
  const owner = exactRecord(
    record.owner,
    ["uid", "gid"],
    "package deferred ZIP tree owner",
  );
  const activation = exactRecord(
    record.activation,
    ["mode", "capabilities", "roots"],
    "package deferred ZIP tree activation",
  );
  if (
    record.schema !== 1 ||
    record.kind !== "kandelo-package-deferred-zip-tree" ||
    typeof record.id !== "string" || !TREE_ID_RE.test(record.id) ||
    utf8Length(record.id) > 255 ||
    record.id.includes("//") || record.id.endsWith("/") ||
    (
      record.content_role !== "source-tree" &&
      record.content_role !== "runtime-tree"
    ) ||
    typeof packageRecord.name !== "string" ||
    !PACKAGE_NAME_RE.test(packageRecord.name) ||
    utf8Length(packageRecord.name) > 255 ||
    typeof packageRecord.output !== "string" ||
    !OUTPUT_NAME_RE.test(packageRecord.output) ||
    utf8Length(packageRecord.output) > 255 ||
    typeof archive.url !== "string" ||
    !isRelativeAssetUrl(archive.url) ||
    archive.url !== packageRecord.output ||
    archive.mode_policy !== "portable-posix-v1" ||
    typeof record.mount_prefix !== "string" ||
    utf8Length(record.mount_prefix) >
      VFS_DEFERRED_TREE_LIMITS.maxPathBytes ||
    canonicalAbsolutePath(record.mount_prefix, true) !== record.mount_prefix ||
    !isOwnerId(owner.uid) ||
    !isOwnerId(owner.gid) ||
    (
      activation.mode !== "first-use" &&
      activation.mode !== "boot-prefetch"
    ) ||
    !Array.isArray(activation.capabilities) ||
    activation.capabilities.length === 0 ||
    activation.capabilities.length >
      VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilities ||
    !activation.capabilities.every((capability) =>
      typeof capability === "string" &&
      utf8Length(capability) <=
        VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilityBytes &&
      /^[a-z0-9][a-z0-9:._-]*$/.test(capability)
    ) ||
    new Set(activation.capabilities).size !==
      activation.capabilities.length ||
    !Array.isArray(activation.roots) ||
    activation.roots.length === 0 ||
    activation.roots.length >
      VFS_DEFERRED_TREE_LIMITS.maxActivationRoots ||
    !activation.roots.every((root) =>
      typeof root === "string" &&
      utf8Length(root) <= VFS_DEFERRED_TREE_LIMITS.maxPathBytes &&
      canonicalAbsolutePath(root, true) === root
    ) ||
    new Set(activation.roots).size !== activation.roots.length
  ) {
    throw new Error("package deferred ZIP tree spec is invalid");
  }
  for (const root of activation.roots as string[]) {
    if (
      record.mount_prefix !== "/" &&
      root !== record.mount_prefix &&
      !root.startsWith(`${record.mount_prefix}/`)
    ) {
      throw new Error(
        `package deferred ZIP tree activation root escapes its mount: ${root}`,
      );
    }
  }
  return {
    schema: 1,
    kind: "kandelo-package-deferred-zip-tree",
    id: record.id,
    content_role: record.content_role,
    package: {
      name: packageRecord.name,
      output: packageRecord.output,
    },
    archive: {
      url: archive.url,
      mode_policy: "portable-posix-v1",
    },
    mount_prefix: record.mount_prefix,
    owner: { uid: owner.uid, gid: owner.gid },
    activation: {
      mode: activation.mode,
      capabilities: [...activation.capabilities] as string[],
      roots: [...activation.roots] as string[],
    },
  };
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort()) !==
      JSON.stringify([...fields].sort())
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
  return record;
}

function canonicalAbsolutePath(
  value: string,
  allowRoot: boolean,
): string | null {
  if (allowRoot && value === "/") return value;
  if (
    !value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.slice(1).split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    return null;
  }
  return value;
}

function isRelativeAssetUrl(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
    value.split("/").every((segment) =>
      segment !== "" && segment !== "." && segment !== ".."
    )
  );
}

function isOwnerId(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_OWNER_ID;
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}
