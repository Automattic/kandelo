'use strict';

const fs = require('node:fs/promises');

Error.prepareStackTrace = (_, frames) => frames.map((site) => ({
  name: site.getFunctionName(),
  async: site.isAsync(),
}));

async function leaf(pending) {
  await pending;
  const error = new Error('constructed');
  const target = {};
  Error.captureStackTrace(target);
  return { constructed: error.stack, recaptured: target.stack };
}

async function awaiting(pending) {
  return await leaf(pending);
}

async function detached(pending) {
  return leaf(pending);
}

async function main() {
  const inputs = {
    resolved: () => Promise.resolve(),
    immediate: () => new Promise((resolve) => setImmediate(resolve)),
    filesystem: () => fs.access(__filename),
  };
  for (const limit of [2, 10, 64]) {
    Error.stackTraceLimit = limit;
    for (const [source, create] of Object.entries(inputs)) {
      for (const invoke of [awaiting, detached]) {
        const result = await invoke(create());
        console.log(JSON.stringify({ limit, source, caller: invoke.name, ...result }));
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
