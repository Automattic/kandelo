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

export interface ComputerSoftwareSnapshot {
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
