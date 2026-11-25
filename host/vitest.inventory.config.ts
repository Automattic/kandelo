import config from "./vitest.config.ts";

// Collection needs the same transforms and file selection as execution.
// Its only job is to declare the cases, so leave fixture compilation to run.
export default { ...config, test: { ...config.test, globalSetup: [] } };
