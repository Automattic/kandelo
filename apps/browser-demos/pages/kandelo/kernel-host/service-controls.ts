import type { KernelHost, KernelOwnedJobOptions } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { COMPUTER_SERVICES_PATH, MAX_COMPUTER_SERVICES_BYTES, ServiceSupervisorStartingError, parseComputerServices, parseComputerServiceStatus, type ComputerServiceController } from "../../../../../web-libs/kandelo-session/src/computer-services";
import { runImageActivityCommand } from "./image-activity-command";

export function createServiceControls(host: KernelHost, account: Pick<KernelOwnedJobOptions, "uid" | "gid" | "env" | "cwd">, assertCurrent: () => void): ComputerServiceController {
  let pending = Promise.resolve();
  let queued = 0;
  const serialize = <Value,>(operation: () => Promise<Value>): Promise<Value> => {
    if (queued >= 2) return Promise.reject(new Error("A service operation is already queued"));
    queued++;
    const result = pending.then(() => { assertCurrent(); return operation(); }).finally(() => { queued--; });
    pending = result.then(() => {}, () => {});
    return result;
  };
  const declarations = async () => {
    assertCurrent();
    const bytes = await host.readVfsFile(COMPUTER_SERVICES_PATH, MAX_COMPUTER_SERVICES_BYTES);
    assertCurrent();
    return bytes === null ? [] : parseComputerServices(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  };
  return {
    list: () => serialize(async () => {
      const services = await declarations();
      if (!services.length) return [];
      const entries = await host.readVfsDir("/run/kandelo-services");
      assertCurrent();
      if (!entries?.some(entry => entry.name === "dinitctl" && (entry.mode & 0o170000) === 0o140000)) throw new ServiceSupervisorStartingError();
      const report = await runImageActivityCommand(host, "/usr/local/bin/kandelo-service inspect", account, assertCurrent, 5_000);
      assertCurrent();
      return parseComputerServiceStatus(report, services);
    }),
    change: (action, id) => serialize(async () => {
      if (!["start", "stop", "enable", "disable"].includes(action) || !(await declarations()).some(service => service.id === id)) throw new Error("Unknown service action or identifier");
      await runImageActivityCommand(host, `/usr/local/bin/kandelo-service ${action} ${id}`, account, assertCurrent);
      assertCurrent();
    }),
  };
}
