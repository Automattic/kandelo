import type { PcmTransportDescriptor } from "./pcm-transport.js";

export type PcmOutputState =
  | "unavailable"
  | "unprepared"
  | "suspended"
  | "running"
  | "interrupted"
  | "closed"
  | "error";

export interface PcmOutputDriver {
  prepare(transport: PcmTransportDescriptor): Promise<void>;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
  getState(): PcmOutputState;
  subscribe(listener: (state: PcmOutputState) => void): () => void;
}
