import assert from "node:assert/strict";
import { ViteStartupOutput } from "./vite-startup-output";

const plain = new ViteStartupOutput();
assert(!plain.push("VITE ready in1948ms\n"));
assert(plain.push("Local: http://127.0.0.1:6259/\n"));
assert(plain.push("later logs"));
const colored = "  ➜  \u001b[1mLocal\u001b[22m: \u001b[36mhttp://127.0.0.1:6259/\u001b[39m\n";
assert(!colored.includes("Local:"), "Counterfactual must reproduce the old literal marker miss");
// Every possible transport split must preserve the colored label, including
// splits inside CSI escape sequences and between the marker's letters.
for (let split = 0; split <= colored.length; split++) {
  const output = new ViteStartupOutput();
  output.push(colored.slice(0, split));
  assert(output.push(colored.slice(split)), "Lost colored marker at split" + split);
}
const bytes = new ViteStartupOutput();
for (const character of colored) bytes.push(character);
assert(bytes.push(""));
const unrelated = new ViteStartupOutput();
assert(!unrelated.push("VITE ready in1ms\n"));
assert(!unrelated.push("Local without colon\n"));
assert(!unrelated.push("\u001b]0;Local:\u0007unrelated output\n"), "OSC title is not a printed address marker");
const bounded = new ViteStartupOutput(64);
assert(!bounded.push("x".repeat(1_000_000)));
assert.equal(bounded.retainedCharacters,64);
assert(bounded.push(colored));
assert(bounded.retainedCharacters<=64);
assert.throws(()=>new ViteStartupOutput(0));
console.log("Vite startup output controls passed: original ANSI miss, every split, no marker, OSC exclusion, sticky readiness and bounded history.");
