#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "yaml"

ROOT = File.expand_path("..", __dir__)
WORKFLOW = ARGV.empty? ?
  File.join(
    ROOT,
    ".github/workflows/homebrew-public-chromium-proof-recovery.yml",
  ) :
  File.expand_path(ARGV.fetch(0))
LOCK = ARGV.length < 2 ?
  File.join(ROOT, "homebrew/public-proof-recovery-lock.json") :
  File.expand_path(ARGV.fetch(1))
RUNNER = ARGV.length < 3 ?
  File.join(
    ROOT,
    "homebrew/test/run_homebrew_guest_browser_shipping_scope.sh",
  ) :
  File.expand_path(ARGV.fetch(2))

KANDELO_REF = "0b0945f5f78b5e7577d08fafffc540408a501cb1"
TAP_CATALOG_REF = "6ad0e3dbc60e5572c4288c86919238f71c1bc110"
TAP_AUTHORITY_REF = "84fcb7b104af0d9440690fd519d5a5a44fda5b80"
CANARY_REF = "d8bdda662f6d80cf3dcdbe8451edb12bb33bbafc"
MIRROR_AUTHORITY_REF = "08f8f32c94bee8d6fc2948e453e53ece29b1c8e1"
RELEASE_TAG =
  "homebrew-guest-lifecycle-inputs-sha256-" \
  "bb5e575fb4d199aa59b764d293aa33501b0e6bfc243868ec5af98d826dafb79f"
MIRROR_TAG =
  "homebrew-shell-bottles-sha256-" \
  "fd15162a8c9c06e6d7936af470cd16ba916528708356750751b55bac567a0ce2"
RUNTIME_HANDOFF = "homebrew-public-browser-runtime-handoff"
WORKFLOW_DIGEST =
  "fe1b60beacf653831ce02bc74693291a5bb41d9f8d284d2ec7a3bf05a3ba9658"
RUNNER_DIGEST =
  "10e69e20c7e5b9a02eec910b0c3edce3baadd6f349bf80bdb4bfc20c86897128"
DOWNLOAD_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
UPLOAD_ACTION =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"

def check(condition, message)
  raise message unless condition
end

def canonical(value)
  case value
  when Hash
    value.keys.sort_by(&:to_s).to_h do |key|
      [key.to_s, canonical(value.fetch(key))]
    end
  when Array
    value.map { |entry| canonical(entry) }
  else
    value
  end
end

def digest(value)
  Digest::SHA256.hexdigest(JSON.generate(canonical(value)))
end

def named_step(job, name)
  matches = job.fetch("steps").select { |step| step["name"] == name }
  check(matches.length == 1, "expected exactly one #{name.inspect} step")
  matches.fetch(0)
end

begin
  workflow = YAML.safe_load(
    File.read(WORKFLOW),
    permitted_classes: [],
    aliases: false,
  )
  lock = JSON.parse(File.read(LOCK))
  runner = File.read(RUNNER)
  check(workflow.is_a?(Hash), "Chromium recovery workflow is not a mapping")
  keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }
  check(
    keys.sort == %w[jobs name on permissions],
    "Chromium recovery workflow top-level contract differs",
  )
  events = workflow.key?("on") ? workflow["on"] : workflow[true]
  check(
    events.keys.sort == %w[pull_request workflow_dispatch],
    "Chromium recovery trigger set differs",
  )
  check(
    events.fetch("workflow_dispatch").nil?,
    "manual Chromium recovery trigger may not accept inputs",
  )
  check(
    workflow.fetch("permissions") == { "contents" => "read" },
    "Chromium recovery permissions differ",
  )

  jobs = workflow.fetch("jobs")
  check(
    jobs.keys.sort == %w[prepare prove],
    "Chromium recovery job set differs",
  )
  prepare = jobs.fetch("prepare")
  prove = jobs.fetch("prove")
  check(!prepare.key?("needs"), "Chromium preparation must be the source job")
  check(prove.fetch("needs") == "prepare", "Chromium proof dependency differs")
  check(
    prepare.fetch("outputs") == {
      "artifact-digest" => "${{ steps.handoff.outputs.artifact-digest }}",
    },
    "Chromium handoff digest output differs",
  )
  check(
    prove.fetch("strategy") == {
      "fail-fast" => false,
      "matrix" => {
        "scope" => %w[core canary],
      },
    },
    "Chromium scopes must use separate fresh runners",
  )
  check(
    prepare.fetch("timeout-minutes") == 90 &&
      prove.fetch("timeout-minutes") == 30,
    "Chromium recovery job time bounds differ",
  )

  allowed_actions = [
    "./.github/actions/fetch-submodules",
    "./.github/actions/setup-nix",
    "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
    "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
    DOWNLOAD_ACTION,
    UPLOAD_ACTION,
  ]
  jobs.each_value do |job|
    job.fetch("steps").filter_map { |step| step["uses"] }.each do |action|
      check(
        allowed_actions.include?(action),
        "Chromium recovery uses an untrusted action: #{action}",
      )
    end
  end

  prepare_source = YAML.dump(prepare)
  prove_source = YAML.dump(prove)
  whole_source = File.read(WORKFLOW)
  check(
    prepare_source.include?("npm --prefix host ci") &&
      prepare_source.include?("npm --prefix apps/browser-demos ci") &&
      prepare_source.include?("scripts/dev-shell.sh") &&
      prepare_source.include?("./run.sh --fetch-only prepare-browser") &&
      prepare_source.include?("npm run build") &&
      prepare_source.include?(
        "scripts/create-homebrew-guest-lifecycle-fixture.ts"
      ) &&
      prepare_source.include?(
        "scripts/create-homebrew-browser-proof-runtime-handoff.sh"
      ),
    "Chromium producer does not own every build-time dependency",
  )
  %w[
    nix
    dev-shell
    fetch-binaries
    resolve-binary
    prepare-browser
    vite
    cargo
    rustc
    npm\ --prefix\ host
    npm\ run\ build
  ].each do |text|
    check(
      !prove_source.downcase.include?(text.downcase),
      "fresh Chromium proof repeats producer work: #{text}",
    )
  end
  proof_install = named_step(
    prove,
    "Install only the Chromium proof dependencies",
  )
  check(
    proof_install.fetch("run").include?("cd \"$BROWSER_ROOT\"") &&
      proof_install.fetch("run").include?(
        "npm ci --ignore-scripts --no-audit --no-fund"
      ) &&
      proof_install.fetch("run").include?(
        "npx playwright install --with-deps chromium"
      ),
    "fresh Chromium dependency installation differs",
  )

  prepare_uploads = prepare.fetch("steps").select do |step|
    step["uses"] == UPLOAD_ACTION
  end
  check(
    prepare_uploads.map { |step| step.fetch("with") } == [
      {
        "name" => RUNTIME_HANDOFF,
        "path" => "${{ steps.runtime.outputs.root }}",
        "retention-days" => 1,
        "if-no-files-found" => "error",
      },
    ],
    "Chromium preparation handoff differs",
  )
  prove_downloads = prove.fetch("steps").select do |step|
    step["uses"] == DOWNLOAD_ACTION
  end
  check(
    prove_downloads.map { |step| step.fetch("with") } == [
      {
        "name" => RUNTIME_HANDOFF,
        "path" =>
          "${{ runner.temp }}/homebrew-public-browser-runtime-handoff",
      },
    ],
    "Chromium proof must download only its same-run runtime",
  )
  [prepare, prove].each do |job|
    checkout = named_step(
      job,
      "Check out exact recovery workflow authority",
    )
    check(
      checkout.fetch("with") == {
        "ref" => "${{ github.sha }}",
        "persist-credentials" => false,
      },
      "Chromium recovery workflow checkout is not exact",
    )
  end

  public_step = named_step(
    prepare,
    "Fetch and verify immutable public product inputs",
  )
  public_run = public_step.fetch("run")
  check(
    public_run.scan("env -u GH_TOKEN -u GITHUB_TOKEN").length == 4 &&
      public_run.scan(".immutable == true").length == 2 &&
      public_run.include?(".target_commitish") &&
      public_run.include?("public-proof-recovery-lock.json") &&
      public_run.include?("sha256sum") &&
      public_run.include?("wc -c"),
    "anonymous immutable Chromium input recovery differs",
  )
  proof_step = named_step(
    prove,
    "Prove the selected stock guest bottle install",
  )
  check(
    proof_step.fetch("timeout-minutes") == 25 &&
      proof_step.fetch("run").include?('"${{ matrix.scope }}"') &&
      proof_step.fetch("run").include?(
        "run_homebrew_guest_browser_shipping_scope.sh"
      ),
    "stock Chromium guest proof scope differs",
  )
  install_step = named_step(
    prove,
    "Verify the exact browser handoff",
  )
  install_run = install_step.fetch("run")
  check(
    install_run.include?(
      "scripts/verify-homebrew-browser-proof-runtime-handoff.sh"
    ) &&
      install_run.include?(
        "--product-kandelo-ref \"$PRODUCT_KANDELO_REF\""
      ) &&
      install_run.include?(
        "--runtime-source-ref \"$RUNTIME_SOURCE_REF\""
      ),
    "fresh Chromium handoff installation differs",
  )

  check(
    Digest::SHA256.hexdigest(runner) == RUNNER_DIGEST &&
      runner.include?("baseline_oom=") &&
      runner.include?("baseline_oom_kill=") &&
      runner.include?("final_oom > baseline_oom") &&
      runner.include?("final_oom_kill > baseline_oom_kill") &&
      runner.include?("KANDELO_PLAYWRIGHT_SERVE_DIST=1") &&
      !runner.include?("--expose-gc"),
    "stock Chromium runner contract differs",
  )

  check(
    lock.fetch("schema") == 1 &&
      lock.fetch("kind") == "kandelo-homebrew-public-proof-recovery" &&
      lock.fetch("kandelo_ref") == KANDELO_REF &&
      lock.fetch("tap_catalog_ref") == TAP_CATALOG_REF &&
      lock.fetch("tap_authority_ref") == TAP_AUTHORITY_REF &&
      lock.fetch("canary_ref") == CANARY_REF,
    "public recovery authority lock differs",
  )
  release = lock.fetch("release")
  check(
    release == {
      "repository" => "Kandelo-dev/homebrew-tap-core",
      "tag" => RELEASE_TAG,
      "target_commitish" => TAP_AUTHORITY_REF,
      "immutable" => true,
      "assets" => {
        "homebrew-bootstrap.zip" => {
          "bytes" => 5_081_250,
          "sha256" =>
            "6b94235c4463a7ae03104decb20910fb660af4d2313fc0c87a84ef02acde440c",
        },
        "homebrew-brew.env" => {
          "bytes" => 210,
          "sha256" =>
            "2eb3f05703b6a6f23feabda24f622bacd068115c7f74a0eac51bb4085e9eec5a",
        },
        "main-shell-brew-package-tree.json" => {
          "bytes" => 641,
          "sha256" =>
            "b1f4b479a8364282700bdada99257160f66a3b314cc6a237d1d52c868a4a9b62",
        },
        "main-shell.vfs.zst" => {
          "bytes" => 5_752_199,
          "sha256" =>
            "d82a397d9b441269b6ea8a0fe1a37d82983a52bd6ed40b8d7387a16c3037218c",
        },
      },
    },
    "public Chromium lifecycle release lock differs",
  )
  mirror = lock.fetch("mirror")
  check(
    mirror == {
      "repository" => "Kandelo-dev/homebrew-tap-core",
      "tag" => MIRROR_TAG,
      "target_commitish" => MIRROR_AUTHORITY_REF,
      "immutable" => true,
      "asset_count" => 37,
      "plan" => {
        "name" => "kandelo-homebrew-bottle-mirror-plan.json",
        "bytes" => 19_373,
        "sha256" =>
          "405d59443b28137a5f00d6405ca07281e1ff5924742ffb8a666d37872063b39a",
      },
    },
    "public Chromium mirror lock differs",
  )

  forbidden = [
    "contents: write",
    "packages: write",
    "secrets:",
    "pull_request_target",
    "run-id:",
    "github.event.workflow_run",
    "gh release",
    "publish-immutable-github-release.sh",
  ]
  forbidden.each do |text|
    check(
      !whole_source.include?(text),
      "Chromium recovery gained forbidden capability: #{text}",
    )
  end
  check(
    digest(workflow) == WORKFLOW_DIGEST,
    "complete public Chromium recovery workflow differs",
  )

  puts "check-homebrew-public-chromium-proof-recovery-workflow.rb: ok"
rescue JSON::ParserError, KeyError, Psych::Exception, RuntimeError => e
  warn(
    "check-homebrew-public-chromium-proof-recovery-workflow.rb: " \
      "#{e.message}",
  )
  exit 1
end
