#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "yaml"

ROOT = File.expand_path("..", __dir__)
WORKFLOW = ARGV.empty? ?
  File.join(
    ROOT,
    ".github/workflows/homebrew-public-node-proof-recovery.yml",
  ) :
  File.expand_path(ARGV.fetch(0))
LOCK = ARGV.length < 2 ?
  File.join(ROOT, "homebrew/public-proof-recovery-lock.json") :
  File.expand_path(ARGV.fetch(1))
RUNNER = ARGV.length < 3 ?
  File.join(ROOT, "homebrew/test/run_homebrew_guest_shipping_scope.sh") :
  File.expand_path(ARGV.fetch(2))

KANDELO_REF = "0b0945f5f78b5e7577d08fafffc540408a501cb1"
TAP_CATALOG_REF = "6ad0e3dbc60e5572c4288c86919238f71c1bc110"
TAP_AUTHORITY_REF = "84fcb7b104af0d9440690fd519d5a5a44fda5b80"
CANARY_REF = "d8bdda662f6d80cf3dcdbe8451edb12bb33bbafc"
RELEASE_TAG =
  "homebrew-guest-lifecycle-inputs-sha256-" \
  "bb5e575fb4d199aa59b764d293aa33501b0e6bfc243868ec5af98d826dafb79f"
RUNTIME_HANDOFF = "homebrew-public-node-runtime-handoff"
WORKFLOW_DIGEST =
  "cb87ad2b0a0a8e71c8c742818af44a3bf3e4dbd23513768421ef95b9bbe6fb23"
RUNNER_DIGEST =
  "d15e23e5b8512663864e56163033cda32b301c873811fd28d04ca557cb1acc58"
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
  check(workflow.is_a?(Hash), "recovery workflow is not a mapping")
  keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }
  check(
    keys.sort == %w[jobs name on permissions],
    "recovery workflow top-level contract differs",
  )
  events = workflow.key?("on") ? workflow["on"] : workflow[true]
  check(
    events.keys.sort == %w[pull_request workflow_dispatch],
    "recovery trigger set differs",
  )
  check(
    events.fetch("workflow_dispatch").nil?,
    "manual recovery trigger may not accept inputs",
  )
  check(
    workflow.fetch("permissions") == { "contents" => "read" },
    "recovery workflow permissions differ",
  )

  jobs = workflow.fetch("jobs")
  check(jobs.keys.sort == %w[prepare prove], "recovery job set differs")
  prepare = jobs.fetch("prepare")
  prove = jobs.fetch("prove")
  check(!prepare.key?("needs"), "recovery preparation must be the source job")
  check(prove.fetch("needs") == "prepare", "proof dependency differs")
  check(
    prepare.fetch("outputs") == {
      "artifact-digest" => "${{ steps.handoff.outputs.artifact-digest }}",
    },
    "recovery handoff digest output differs",
  )
  check(
    prove.fetch("strategy") == {
      "fail-fast" => false,
      "matrix" => {
        "scope" => %w[shipping-core shipping-canary],
      },
    },
    "recovery scopes must use separate fresh runners",
  )
  check(
    prepare.fetch("timeout-minutes") == 45 &&
      prove.fetch("timeout-minutes") == 30,
    "recovery job time bounds differ",
  )

  allowed_actions = [
    "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
    "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
    DOWNLOAD_ACTION,
    UPLOAD_ACTION,
    "DeterminateSystems/nix-installer-action@" \
      "ef8a148080ab6020fd15196c2084a2eea5ff2d25",
    "DeterminateSystems/magic-nix-cache-action@" \
      "908b263ff629f4cc17666315b7fd3ec127c6244d",
  ]
  jobs.each_value do |job|
    job.fetch("steps").filter_map { |step| step["uses"] }.each do |action|
      check(
        allowed_actions.include?(action),
        "recovery uses an untrusted or unpinned action: #{action}",
      )
    end
  end

  prepare_source = YAML.dump(prepare)
  prove_source = YAML.dump(prove)
  whole_source = File.read(WORKFLOW)
  check(
      prepare_source.include?("npm ci --no-audit --no-fund") &&
      prepare_source.include?("npm --prefix host ci") &&
      prepare_source.include?("scripts/dev-shell.sh") &&
      prepare_source.include?('cd "$GITHUB_WORKSPACE/product"') &&
      prepare_source.include?(
        '"$GITHUB_WORKSPACE/scripts/' \
          'create-homebrew-node-proof-runtime-handoff.sh"'
      ) &&
      prepare_source.include?("--fetch-only --package kernel") &&
      prepare_source.include?(
        "scripts/create-homebrew-node-proof-runtime-handoff.sh"
      ),
    "recovery preparation does not own every build-time dependency",
  )
  %w[nix npm npx tsx fetch-binaries.sh resolve-binary.sh dev-shell.sh].each do |text|
    check(
      !prove_source.downcase.include?(text.downcase),
      "fresh proof repeats preparation dependency: #{text}",
    )
  end
  check(
    !prove_source.include?("--expose-gc") &&
      !prove_source.include?("maxWorkers") &&
      !prove_source.include?("MAX_WORKERS"),
    "fresh proof changes product memory or worker policy",
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
    "recovery preparation handoff differs",
  )
  prove_downloads = prove.fetch("steps").select do |step|
    step["uses"] == DOWNLOAD_ACTION
  end
  check(
    prove_downloads.map { |step| step.fetch("with") } == [
      {
        "name" => RUNTIME_HANDOFF,
        "path" =>
          "${{ runner.temp }}/homebrew-public-node-runtime-handoff",
      },
    ],
    "recovery proof must download only its same-run runtime",
  )

  product_checkout = named_step(
    prepare,
    "Check out exact published product authority",
  )
  check(
    product_checkout.fetch("with") == {
      "repository" => "Automattic/kandelo",
      "ref" => KANDELO_REF,
      "path" => "product",
      "persist-credentials" => false,
    },
    "published product checkout differs",
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
      "recovery workflow checkout is not exact",
    )
  end

  public_step = named_step(
    prove,
    "Verify runtime and fetch immutable public inputs",
  )
  public_run = public_step.fetch("run")
  check(
    public_run.scan("env -u GH_TOKEN -u GITHUB_TOKEN").length == 2 &&
      public_run.include?(".target_commitish == $target") &&
      public_run.include?(".immutable == true") &&
      public_run.include?("public-proof-recovery-lock.json") &&
      public_run.include?(
        "verify-homebrew-node-proof-runtime-handoff.sh"
      ),
    "anonymous immutable recovery readback differs",
  )
  proof_step = named_step(
    prove,
    "Prove the selected stock guest bottle install",
  )
  check(
    proof_step.fetch("timeout-minutes") == 20 &&
      proof_step.fetch("run").include?('"${{ matrix.scope }}"') &&
      proof_step.fetch("env").fetch("TAP_CATALOG_REF") ==
        TAP_CATALOG_REF &&
      proof_step.fetch("env").fetch("CANARY_REF") == CANARY_REF,
    "stock guest proof scope differs",
  )
  check(
    Digest::SHA256.hexdigest(runner) == RUNNER_DIGEST &&
      runner.include?('node "$node_entry"') &&
      runner.include?("--timeout-ms 900000") &&
      !runner.include?("--expose-gc"),
    "stock guest runner contract differs",
  )

  check(
    lock == {
      "schema" => 1,
      "kind" => "kandelo-homebrew-public-proof-recovery",
      "kandelo_ref" => KANDELO_REF,
      "tap_catalog_ref" => TAP_CATALOG_REF,
      "tap_authority_ref" => TAP_AUTHORITY_REF,
      "canary_ref" => CANARY_REF,
      "release" => {
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
    },
    "public recovery lock differs",
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
      "recovery gained forbidden capability: #{text}",
    )
  end
  check(
    digest(workflow) == WORKFLOW_DIGEST,
    "complete public Node recovery workflow differs",
  )

  puts "check-homebrew-public-node-proof-recovery-workflow.rb: ok"
rescue JSON::ParserError, KeyError, Psych::Exception, RuntimeError => e
  warn "check-homebrew-public-node-proof-recovery-workflow.rb: #{e.message}"
  exit 1
end
