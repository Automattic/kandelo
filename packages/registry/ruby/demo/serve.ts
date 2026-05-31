/**
 * serve.ts — Run Ruby 3.3.6 in the kandelo.
 *
 * Usage:
 *   bash packages/registry/ruby/build-ruby.sh
 *   npx tsx packages/registry/ruby/demo/serve.ts [ruby-args...]
 *
 * Examples:
 *   npx tsx packages/registry/ruby/demo/serve.ts -e "puts 'Hello from Ruby!'"
 *   npx tsx packages/registry/ruby/demo/serve.ts script.rb
 *   npx tsx packages/registry/ruby/demo/serve.ts -e "p RUBY_VERSION"
 */

import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../../../..");

async function main() {
    const rubyWasm = resolve(repoRoot, "packages/registry/ruby/bin/ruby.wasm");
    const rubyLib = resolve(repoRoot, "packages/registry/ruby/ruby-install/lib/ruby/3.3.0");

    if (!existsSync(rubyWasm)) {
        console.error("ruby.wasm not found. Run: bash packages/registry/ruby/build-ruby.sh");
        process.exit(1);
    }

    // Pass through CLI args after serve.ts
    const rubyArgs = process.argv.slice(2);
    if (rubyArgs.length === 0) {
        rubyArgs.push("-e", 'puts "Ruby #{RUBY_VERSION} on wasm32-posix-kernel"');
    }
    const argv = ["ruby", ...rubyArgs];

    const result = await runCentralizedProgram({
        programPath: rubyWasm,
        argv,
        env: [
            `RUBYLIB=${rubyLib}`,
            `HOME=/tmp`,
            `TMPDIR=/tmp`,
        ],
        timeout: 300_000,
    });

    process.stdout.write(result.stdout);
    if (result.stderr) {
        process.stderr.write(result.stderr);
    }
    process.exit(result.exitCode);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
