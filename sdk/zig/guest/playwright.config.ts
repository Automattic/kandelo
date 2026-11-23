import base from "../playwright.config";

export default {
  ...base,
  fullyParallel: true,
  testDir: import.meta.dirname,
  testMatch: "guest.spec.ts",
};
