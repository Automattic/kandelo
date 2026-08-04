import type {
  HomebrewQueryCommand,
  HomebrewQueryCommandResult,
  HomebrewQueryFixtureManifest,
  HomebrewQueryNetworkAudit,
  HomebrewQueryScenarioResult,
} from "./contracts";

export interface HomebrewQueryMachine {
  start(): Promise<number>;
  run(command: HomebrewQueryCommand): Promise<HomebrewQueryCommandResult>;
  auditNetwork(
    commands: readonly HomebrewQueryCommand[],
  ): Promise<HomebrewQueryNetworkAudit>;
  destroy(): Promise<void>;
}

export interface HomebrewQueryMachineFactory {
  create(image: "lazy" | "eager"): Promise<HomebrewQueryMachine>;
}

const SHELL_BOOT_COMMAND: HomebrewQueryCommand = {
  id: "shell_boot",
  argv: [":"],
};

export async function runHomebrewQueryScenario(options: {
  fixture: HomebrewQueryFixtureManifest;
  machines: HomebrewQueryMachineFactory;
  auditNetwork: boolean;
}): Promise<HomebrewQueryScenarioResult> {
  const focus = options.fixture.commands.find(
    (command) => command.id === options.fixture.focusCommandId,
  )!;

  const coldStartedAt = performance.now();
  const coldMachine = await options.machines.create("lazy");
  let cold: HomebrewQueryScenarioResult["cold"];
  try {
    const machineBootMs = await coldMachine.start();
    const first = await coldMachine.run(focus);
    const machineBootAndFirstBrewMs = performance.now() - coldStartedAt;
    const warm = await coldMachine.run(focus);
    cold = {
      machineBootMs,
      machineBootAndFirstBrewMs,
      first,
      warm,
    };
  } finally {
    await coldMachine.destroy();
  }

  const bootedMachine = await options.machines.create("lazy");
  try {
    const bootedMachineBootMs = await bootedMachine.start();
    const shellBoot = await bootedMachine.run(SHELL_BOOT_COMMAND);
    const first: HomebrewQueryCommandResult[] = [];
    const repeated: HomebrewQueryCommandResult[] = [];
    for (const command of options.fixture.commands) {
      first.push(await bootedMachine.run(command));
    }
    for (const command of options.fixture.commands) {
      repeated.push(await bootedMachine.run(command));
    }
    const networkAudit = options.auditNetwork
      ? await bootedMachine.auditNetwork(options.fixture.commands)
      : undefined;

    let eager: HomebrewQueryScenarioResult["eager"];
    if (options.fixture.eagerRootfs !== undefined) {
      const eagerMachine = await options.machines.create("eager");
      try {
        const machineBootMs = await eagerMachine.start();
        const eagerShellBoot = await eagerMachine.run(SHELL_BOOT_COMMAND);
        eager = {
          machineBootMs,
          shellBootMs: eagerShellBoot.elapsedMs,
          first: await eagerMachine.run(focus),
          warm: await eagerMachine.run(focus),
        };
      } finally {
        await eagerMachine.destroy();
      }
    }

    return {
      cold,
      booted: {
        machineBootMs: bootedMachineBootMs,
        shellBootMs: shellBoot.elapsedMs,
        first,
        warm: repeated,
      },
      ...(eager === undefined ? {} : { eager }),
      ...(networkAudit === undefined ? {} : { networkAudit }),
    };
  } finally {
    await bootedMachine.destroy();
  }
}
