import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ViteStartupOutput } from "../../scripts/vite-startup-output";

const colored = "  ➜  \u001b[1mLocal\u001b[22m: \u001b[36mhttp://127.0.0.1:6259/\u001b[39m\n";

describe("Vite startup output", () => {
  it("stays ready after observing the local address", () => {
    const output = new ViteStartupOutput();
    assert(!output.push("VITE ready in 1948ms\n"));
    assert(output.push("Local: http://127.0.0.1:6259/\n"));
    assert(output.push("later logs"));
  });

  it("recognizes colored labels across every transport split", () => {
    assert(!colored.includes("Local:"), "Control must reproduce the old literal marker miss");
    for (let split = 0; split <= colored.length; split++) {
      const output = new ViteStartupOutput();
      output.push(colored.slice(0, split));
      assert(output.push(colored.slice(split)), `Lost colored marker at split ${split}`);
    }
    const output = new ViteStartupOutput();
    for (const character of colored) output.push(character);
    assert(output.push(""));
  });

  it("ignores unrelated text and terminal window titles", () => {
    const output = new ViteStartupOutput();
    assert(!output.push("VITE ready in 1ms\n"));
    assert(!output.push("Local without colon\n"));
    assert(!output.push("\u001b]0;Local:\u0007unrelated output\n"), "OSC title is not a printed address marker");
  });

  it("bounds retained history even for an oversized log write", () => {
    const output = new ViteStartupOutput(64);
    assert(!output.push("x".repeat(1_000_000)));
    assert.equal(output.retainedCharacters, 64);
    assert(output.push(colored));
    assert(output.retainedCharacters <= 64);
    assert.throws(() => new ViteStartupOutput(0));
  });
});
