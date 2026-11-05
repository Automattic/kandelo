export type SoftwareRecovery = "none" | "incomplete" | "pending" | "active" | "rolled-back" | "unknown";
export type SoftwareOperation = "install" | "resume" | "rollback" | "discard" | "release" | "inspect";

export interface ComputerSoftwareProgress {
  files: number;
  installedVerified: number;
  stagedVerified: number;
  path: string;
  completed: string;
  total: string;
}

export const INCOMPATIBLE_SOFTWARE = "This computer's installed software cannot run on this version of Kandelo. Your files are preserved. Update from this release to start it.";

export const NOT_UPDATABLE_SOFTWARE = "This computer's software cannot run on this version of Kandelo, and it was saved before software updates existed, so it cannot be updated. Your files are preserved.";

export interface ComputerSoftwareSnapshot {
  /** The installed software targets a program contract this runtime cannot run. */
  incompatible?: boolean;
  /** False when the computer has no software inventory to update from. */
  updatable?: boolean;
  available: boolean;
  targetAvailable: boolean;
  maintenance: boolean;
  busy: boolean;
  recovery: SoftwareRecovery;
  operation: SoftwareOperation | null;
  progress: ComputerSoftwareProgress | null;
  error: string | null;
}

export interface ComputerSoftwareController {
  getSnapshot(): ComputerSoftwareSnapshot;
  subscribe(listener: () => void): () => void;
  enter(): Promise<void>;
  install(): Promise<void>;
  resume(): Promise<void>;
  rollback(): Promise<void>;
  discard(): Promise<void>;
  boot(): Promise<void>;
  cancel(): void;
}
