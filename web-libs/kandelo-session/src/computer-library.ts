import type { BootDescriptor } from "./kernel-host";

export type ComputerRetention = "saved" | "temporary";
export const DEFAULT_COMPUTER_RETENTION: ComputerRetention = "temporary";
export const JOURNALED_OPFS_IMAGE_STORAGE_FORMAT = "kandelo-opfs-image-v1";
export type ComputerStorageFormat = typeof JOURNALED_OPFS_IMAGE_STORAGE_FORMAT;

export class UnsupportedComputerStorageFormatError extends Error {
  constructor(value: unknown) {
    const identifier = typeof value === "string" && value.length <= 128 ? JSON.stringify(value) : "(missing or invalid identifier)";
    super(`Unsupported computer storage format ${identifier}`);
    this.name = "UnsupportedComputerStorageFormatError";
  }
}

export function assertComputerStorageFormat(value: unknown): asserts value is ComputerStorageFormat {
  if (value !== JOURNALED_OPFS_IMAGE_STORAGE_FORMAT) {
    throw new UnsupportedComputerStorageFormatError(value);
  }
}

export function computerStorageFormatLabel(format: ComputerStorageFormat): string {
  assertComputerStorageFormat(format);
  return "Journaled OPFS image";
}

export interface StoredComputer {
  version: 2;
  id: string;
  title: string;
  storageFormat: ComputerStorageFormat;
  descriptor: BootDescriptor;
  profileId: string | null;
  filesystemProfileId?: string | null;
  retention: ComputerRetention;
  createdAt: number;
  lastOpenedAt: number;
  expiresAt: number | null;
}

export interface ComputerLibrarySnapshot {
  current: StoredComputer | null;
  computers: readonly StoredComputer[];
  issues: readonly { id: string; message: string }[];
  storageProtected: boolean;
}

export interface ComputerLibrary {
  getSnapshot(): ComputerLibrarySnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  create(descriptor: BootDescriptor, retention?: ComputerRetention, title?: string): Promise<void>;
  open(id: string, profileId?: string): Promise<void>;
  bootProfiles(id: string): Promise<ComputerBootProfile[]>;
  keep(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface ComputerBootProfile {
  id: string;
  title: string;
  summary: string;
  selected: boolean;
}

export function filesystemProfileId(computer: StoredComputer): string | null {
  return computer.filesystemProfileId === undefined ? computer.profileId : computer.filesystemProfileId;
}
