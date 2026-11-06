import type { TerminalSessionPolicy } from "../../../../../web-libs/kandelo-session/src/kernel-host";

export const DEMO_TERMINAL_SESSION_POLICY: TerminalSessionPolicy = {
  initial: {
    programPath: "/bin/login",
    argv: ["login", "-p", "-f", "maker"],
    uid: 0,
    gid: 0,
  },
  afterExit: {
    programPath: "/bin/login",
    argv: ["login", "-p"],
    uid: 0,
    gid: 0,
  },
  shortRunThresholdMs: 2_000,
  initialRestartDelayMs: 250,
  maximumRestartDelayMs: 5_000,
};
