import { describe, expect, it } from "vitest";
import { playwrightPort } from "../playwright-run";

describe("Playwright server ports", () => {
  it("accepts an OS-selected port and preserves explicit selections", async () => {
    const port = await playwrightPort(undefined);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThanOrEqual(65535);
    // Do not re-bind the probe's released port: losing that race is allowed
    // and is handled by the real runner's strict-port/no-reuse policy.
    expect(await playwrightPort("57419")).toBe(57419);
  });
  it("rejects invalid explicit ports", async () => {
    for (const value of ["", "0", "1023", "65536", "abc", "1.5"]) {
      await expect(playwrightPort(value)).rejects.toThrow("Invalid Playwright port");
    }
  });
});
