#!/usr/bin/env ruby
# frozen_string_literal: true

require "yaml"

ROOT = File.expand_path("..", __dir__)
WORKFLOW = ARGV.empty? ?
  File.join(ROOT, ".github/workflows/abi-staging-pr-check.yml") :
  File.expand_path(ARGV.fetch(0))
MERGE_GATE = File.join(ROOT, ".github/workflows/abi-staging-merge-gate.yml")

CHECKOUT = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
DOWNLOAD = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
FULL_ACTION = %r{\A(?:\./|[^@]+@[0-9a-f]{40}\z)}

def check(condition, message)
  raise message unless condition
end

def events(workflow)
  workflow.key?("on") ? workflow.fetch("on") : workflow.fetch(true)
end

def run_source(job)
  job.fetch("steps").filter_map { |step| step["run"] }.join("\n")
end

def values(node, result = [])
  case node
  when Hash
    node.each do |key, value|
      result << key.to_s
      values(value, result)
    end
  when Array
    node.each { |value| values(value, result) }
  else
    result << node.to_s
  end
  result
end

def named_step(job, name)
  matches = job.fetch("steps").select { |step| step["name"] == name }
  check(matches.length == 1, "expected one #{name.inspect} step")
  matches.fetch(0)
end

def check_filtered_host_target(source, role, expected_count = 1)
  lines = source.lines.map(&:strip)
  validation = '[[ "$host_target" =~ ^[A-Za-z0-9_.-]+$ ]]'
  assignments = lines.count { |line| line.start_with?("host_target=$(") }
  sequences = lines.each_index.count do |index|
    first = lines.fetch(index)
    if first.start_with?("host_target=$(cd ") && first.end_with?("&&")
      lines[index + 1] == "bash scripts/dev-shell.sh rustc -vV |" &&
        lines[index + 2] == "awk '/^host: / { print $2 }')" &&
        lines[index + 3] == validation
    else
      first == "host_target=$(bash scripts/dev-shell.sh rustc -vV |" &&
        lines[index + 1] == "awk '/^host: / { print $2 }')" &&
        lines[index + 2] == validation
    end
  end
  check(assignments == expected_count && sequences == expected_count,
        "#{role} does not filter then immediately validate each noisy dev-shell target " \
          "(assignments=#{assignments}, ordered=#{sequences}, expected=#{expected_count})")
end

def check_actions(workflow)
  workflow.fetch("jobs").each_value do |job|
    job.fetch("steps").each do |step|
      next unless step.key?("uses")

      check(step.fetch("uses").match?(FULL_ACTION),
            "action is not pinned to a full SHA: #{step.fetch('uses')}")
      next unless step.fetch("uses").start_with?(CHECKOUT)

      check(step.fetch("with", {}).fetch("persist-credentials", nil) == false,
            "every checkout must disable persisted credentials")
    end
  end
end

def check_workflow(workflow)
  check(workflow.fetch("permissions") == {}, "workflow permissions must be empty")
  trigger = events(workflow)
  check(trigger.keys.sort == %w[pull_request_target schedule workflow_dispatch],
        "PR Check triggers changed")
  check(trigger.dig("pull_request_target", "types") == %w[opened synchronize reopened labeled],
        "pull_request_target events changed")
  check(trigger.fetch("schedule") == [{"cron" => "*/5 * * * *"}],
        "PR Check must reconcile every five minutes")
  manual = trigger.dig("workflow_dispatch", "inputs", "pull-request-number")
  check(manual.is_a?(Hash) && manual["required"] == false && manual["type"] == "string",
        "manual PR Check input changed")

  jobs = workflow.fetch("jobs")
  check(jobs.keys == %w[enumerate-open-prs collect-project publish-check],
        "PR Check must retain the reviewed three-job split")
  enumerate = jobs.fetch("enumerate-open-prs")
  collect = jobs.fetch("collect-project")
  publish = jobs.fetch("publish-check")
  check(enumerate.fetch("permissions") == {"contents" => "read"},
        "PR enumeration permissions changed")
  check(collect.fetch("permissions") == {"contents" => "read"},
        "collector must remain read-only")
  check(publish.fetch("permissions") == {
          "actions" => "read", "checks" => "write", "contents" => "read"
        }, "publisher permissions changed")
  check(Array(collect.fetch("needs")) == ["enumerate-open-prs"],
        "collector dependency changed")
  check(Array(publish.fetch("needs")) == %w[enumerate-open-prs collect-project],
        "publisher dependency changed")
  [enumerate, collect, publish].each do |job|
    check(job.fetch("timeout-minutes").between?(1, 120), "job timeout is invalid")
    check(job.fetch("steps").none? { |step| step["continue-on-error"] == true },
          "workflow may not swallow a trust-boundary failure")
  end

  check_actions(workflow)
  flattened = values(workflow).join("\n")
  check(!flattened.match?(/\bsecrets\b/i), "PR Check workflow may not use secrets")
  check(!flattened.include?("refs/pull/") && !flattened.include?("/merge"),
        "PR Check workflow may not use a synthetic merge")
  check(!flattened.match?(/git\s+merge\b/), "PR Check workflow may not synthesize a merge")
  check(!flattened.match?(/sort.*(?:created_at|updated_at|timestamp|asset_id)/i),
        "timestamps or asset IDs may not select current evidence")
  check(!flattened.match?(/\bsleep\s+[0-9]/), "PR Check workflow may not sleep a runner")

  enumerate_source = run_source(enumerate)
  check(enumerate_source.include?("git/ref/heads/main") &&
        enumerate_source.include?("kandelo-dev/homebrew-tap-core") &&
        enumerate_source.include?("length <= 256") &&
        enumerate_source.include?("head.repo.full_name") &&
        enumerate_source.include?("map({subject: .})"),
        "enumeration does not bind protected revisions and same-repository heads")

  collect_source = run_source(collect)
  check(collect_source.include?("request classify") &&
        collect_source.include?("--changed-paths") &&
        collect_source.include?("request requirements") &&
        collect_source.include?("--expected-requirements") &&
        collect_source.include?("scripts.abi_staging.check_projection") &&
        collect_source.include?("check-projection project") &&
        collect_source.include?("env -u GH_TOKEN -u GITHUB_TOKEN git") &&
        collect_source.include?("status --porcelain=v1 --untracked-files=all") &&
        collect_source.include?("HEAD^{tree}"),
        "collector does not derive and project protected current identity")
  check_filtered_host_target(collect_source, "collector")
  check(!collect_source.match?(%r{(?:bash|source|\.)\s+[^\n]*exact-head}),
        "collector executes candidate-head code")
  check(!collect.fetch("env", {}).key?("GH_TOKEN"),
        "collector exposes GitHub credentials job-wide")
  candidate_checkout = named_step(collect, "Checkout inert exact PR head")
  check(candidate_checkout.fetch("uses").start_with?(CHECKOUT) &&
        candidate_checkout.dig("with", "ref") == "${{ matrix.subject.head }}" &&
        candidate_checkout.dig("with", "path") == "exact-head",
        "collector does not check out the exact PR head as inert data")
  musl_step = named_step(collect, "Materialize exact musl gitlink as inert data")
  musl_source = musl_step.fetch("run")
  check(musl_source.include?("authority/scripts/fetch-exact-musl-gitlink.sh") &&
        musl_source.include?('--source-root "$GITHUB_WORKSPACE/exact-head"') &&
        musl_source.include?('--commit "$EXPECTED_HEAD"') &&
        !musl_source.include?("git submodule") &&
        !musl_step.fetch("env", {}).key?("GH_TOKEN"),
        "collector does not materialize the exact musl gitlink through protected code")
  checkout_index = collect.fetch("steps").index(candidate_checkout)
  musl_index = collect.fetch("steps").index(musl_step)
  collect_index = collect.fetch("steps").index do |step|
    step["run"]&.include?("request requirements")
  end
  check(checkout_index < musl_index && musl_index < collect_index,
        "collector musl materialization is not ordered before requirements")
  upload = named_step(collect, "Transfer bounded inert projection")
  check(upload.fetch("uses").start_with?(UPLOAD) &&
        upload.dig("with", "name").to_s.include?("matrix.subject.head") &&
        upload.dig("with", "path").to_s.include?("projection-input.json") &&
        upload.dig("with", "path").to_s.include?("projection.json") &&
        upload.dig("with", "if-no-files-found") == "error",
        "collector artifact identity is not exact and bounded")

  publish_source = run_source(publish)
  check(publish_source.include?("check-projection project") &&
        publish_source.include?("cmp -s") &&
        publish_source.include?("update-abi-staging-check.sh") &&
        publish_source.include?("--details-url") &&
        publish_source.include?("github.run_id") &&
        publish_source.include?("required-check-activation.toml") &&
        publish_source.include?("artifact-ids") == false,
        "publisher does not reproject and use the narrow update adapter")
  check_filtered_host_target(publish_source, "publisher")
  check(!publish_source.match?(%r{(?:bash|source|\.)\s+[^\n]*exact-head}),
        "publisher executes candidate-head code")
  locate = named_step(publish, "Locate exact projection artifact")
  check(locate.fetch("run").include?("[.[].artifacts[]][0]"),
        "publisher selects an artifact from only the first API page")
  download = named_step(publish, "Download exact projection artifact")
  check(download.fetch("uses").start_with?(DOWNLOAD) &&
        download.dig("with", "artifact-ids") == "${{ steps.locate.outputs.artifact-id }}" &&
        download.dig("with", "merge-multiple") == true,
        "publisher does not download the exact located artifact ID")
end

def check_merge_gate(workflow)
  check(workflow.fetch("permissions") == {},
        "protected merge-evidence workflow permissions must be empty")
  trigger = events(workflow)
  check(trigger.keys == ["pull_request_target"],
        "protected merge evidence must use only pull_request_target")
  check(trigger.dig("pull_request_target", "types") == ["labeled"],
        "protected merge evidence must run only for a label event")

  jobs = workflow.fetch("jobs")
  check(jobs.keys == %w[
          capture-current-subject abi-staging-exact-head-structure
          validate-current-evidence
        ], "protected merge evidence must retain the reviewed three-job split")
  capture = jobs.fetch("capture-current-subject")
  structure = jobs.fetch("abi-staging-exact-head-structure")
  validate = jobs.fetch("validate-current-evidence")
  check_filtered_host_target(
    run_source(validate), "merge-gate evidence validator", 2
  )
  check(capture.fetch("permissions") == {"contents" => "read"},
        "subject capture must remain read-only")
  check(structure.fetch("permissions") == {"contents" => "read"},
        "exact-head structure must remain read-only")
  check(validate.fetch("permissions") == {
          "actions" => "read", "checks" => "read", "contents" => "read"
        }, "protected evidence validation permissions changed")
  check(Array(structure.fetch("needs")) == ["capture-current-subject"],
        "structural job dependency changed")
  check(Array(validate.fetch("needs")) == %w[
          capture-current-subject abi-staging-exact-head-structure
        ], "evidence validator dependency changed")

  [capture, structure, validate].each do |job|
    check(job.fetch("timeout-minutes").between?(1, 120),
          "protected merge-evidence timeout is invalid")
    check(job.fetch("steps").none? { |step| step["continue-on-error"] == true },
          "protected merge evidence may not swallow a trust-boundary failure")
  end
  check_actions(workflow)
  jobs.each_value do |job|
    job.fetch("steps").each do |step|
      next unless step.fetch("uses", "").start_with?("./")

      check(step.fetch("uses").start_with?("./abi-staging-authority/"),
            "protected merge evidence uses a candidate-controlled local action")
    end
  end
  flattened = values(workflow).join("\n")
  check(!flattened.match?(/\bsecrets\b/i),
        "protected merge evidence may not use secrets")
  check(!flattened.include?("refs/pull/") && !flattened.include?("/merge"),
        "protected merge evidence may not use a synthetic merge")
  check(!flattened.match?(/git\s+merge\b/),
        "protected merge evidence may not synthesize a merge")
  check(!flattened.match?(/\bsleep\s+[0-9]/),
        "protected merge evidence may not sleep a runner")

  capture_source = run_source(capture)
  check(capture.fetch("if").include?("ready-to-ship") &&
        capture.fetch("if").include?("head.repo.full_name == github.repository") &&
        capture_source.include?("git/ref/heads/main") &&
        capture_source.include?("/pulls/$PR_NUMBER") &&
        capture_source.include?("head.repo.full_name") &&
        capture_source.include?("labels") &&
        capture_source.include?("protected-sha") &&
        capture_source.include?("exact-head"),
        "subject capture does not bind the current protected and exact heads")

  authority = named_step(structure, "Checkout captured protected ABI authority")
  check(authority.fetch("uses").start_with?(CHECKOUT) &&
        authority.dig("with", "ref") ==
          "${{ needs.capture-current-subject.outputs.protected-sha }}" &&
        authority.dig("with", "path") == "abi-staging-authority",
        "structural authority checkout is not the captured protected revision")
  exact = named_step(structure, "Checkout exact PR head for structural ABI check")
  check(exact.fetch("uses").start_with?(CHECKOUT) &&
        exact.dig("with", "ref") ==
          "${{ needs.capture-current-subject.outputs.exact-head }}" &&
        exact.dig("with", "path") == "abi-staging-exact-head",
        "structural job does not execute the exact PR head")
  structure_step = named_step(
    structure, "Run uncredentialed exact-head structural ABI check"
  )
  structure_source = structure_step.fetch("run")
  check(structure_source.include?(
          "env -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_RUNTIME_TOKEN"
        ) &&
        structure_source.include?("env -i") &&
        structure_source.include?('HOME="$candidate_home"') &&
        structure_source.include?("ABI_CHECK_BASE_REF=\"$PROTECTED_SHA\"") &&
        structure_source.include?("scripts/dev-shell.sh") &&
        structure_source.include?("bash scripts/check-abi-version.sh") &&
        structure_source.include?("kandelo-structural-abi-report") &&
        !structure_source.include?("SYNTHETIC_MERGE_SHA"),
        "structural job does not emit bounded uncredentialed exact-head evidence")
  structure.fetch("steps").each do |step|
    next if step.equal?(structure_step)

    check(!step.fetch("run", "").match?(
            %r{(?:bash|source|\.)\s+[^\n]*abi-staging-exact-head}
          ), "candidate execution escaped the reviewed structural step")
  end
  upload = named_step(structure, "Transfer exact-head structural ABI evidence")
  check(upload.fetch("uses").start_with?(UPLOAD) &&
        upload.dig("with", "name").to_s.include?("exact-head") &&
        upload.dig("with", "path").to_s.include?("structural-report.json") &&
        upload.dig("with", "path").to_s.include?("structural-failure.json") &&
        upload.dig("with", "if-no-files-found") == "error",
        "structural artifact is not exact-head and bounded")

  gate_authority = named_step(validate, "Checkout captured protected ABI gate authority")
  check(gate_authority.fetch("uses").start_with?(CHECKOUT) &&
        gate_authority.dig("with", "ref") ==
          "${{ needs.capture-current-subject.outputs.protected-sha }}" &&
        gate_authority.dig("with", "path") == "abi-staging-authority",
        "gate authority checkout is not protected")
  gate_exact = named_step(validate, "Checkout inert exact PR head for ABI gate")
  check(gate_exact.fetch("uses").start_with?(CHECKOUT) &&
        gate_exact.dig("with", "ref") ==
          "${{ needs.capture-current-subject.outputs.exact-head }}" &&
        gate_exact.dig("with", "path") == "abi-staging-exact-head",
        "gate does not inspect the exact PR head as inert data")
  gate_exact_index = validate.fetch("steps").index(gate_exact)
  gate_musl = named_step(
    validate, "Materialize exact musl gitlink as inert data"
  )
  gate_musl_index = validate.fetch("steps").index(gate_musl)
  gate_musl_source = gate_musl.fetch("run")
  download_structure = named_step(
    validate, "Download exact-head structural ABI evidence"
  )
  check(download_structure.fetch("uses").start_with?(DOWNLOAD) &&
        download_structure.dig("with", "name").to_s.include?("exact-head") &&
        download_structure.dig("with", "merge-multiple") == true,
        "gate does not download the exact current-run structural artifact")

  provenance = named_step(
    validate, "Validate current request and locate protected Check provenance"
  )
  provenance_index = validate.fetch("steps").index(provenance)
  check(gate_exact_index < gate_musl_index &&
        gate_musl_index < provenance_index &&
        gate_musl_source.include?(
          "abi-staging-authority/scripts/fetch-exact-musl-gitlink.sh"
        ) &&
        gate_musl_source.include?(
          '--source-root "$GITHUB_WORKSPACE/abi-staging-exact-head"'
        ) &&
        gate_musl_source.include?('--commit "$EXPECTED_HEAD"') &&
        gate_musl.dig("env", "EXPECTED_HEAD") ==
          "${{ needs.capture-current-subject.outputs.exact-head }}" &&
        !gate_musl_source.include?("git submodule") &&
        !gate_musl.fetch("env", {}).key?("GH_TOKEN"),
        "gate does not materialize exact musl data through protected code")
  check(!provenance.key?("if") && provenance["continue-on-error"] != true,
        "current evidence validation must be unconditional and non-swallowing")
  provenance_source = provenance.fetch("run")
  required_fragments = [
    "--previous-abi", "structural-report validate", "request classify",
    "request derive", "filter=all", "EXPECTED_EXTERNAL_ID",
    ".external_id == $external", ".head_sha == $head",
    ".status == \"completed\"", ".conclusion == \"success\"",
    ".details_url", ".app.slug == \"github-actions\"",
    "/actions/runs/$run_id",
    ".path == \".github/workflows/abi-staging-pr-check.yml@main\"",
    ".head_sha == $protected", ".html_url == $details",
    "abi-staging-pr-check-$run_id-$PR_NUMBER-$PR_HEAD_SHA",
    "/actions/runs/$run_id/artifacts", ".workflow_run.id == $run_id",
    ".workflow_run.head_sha == $protected", "[.[].artifacts[]][0]",
    "artifact-id", "run-id",
    "mode == \"observe\"", "mode == \"enforce\""
  ]
  check(required_fragments.all? { |fragment| provenance_source.include?(fragment) },
        "gate does not bind current request and protected Check-run provenance")

  projection_download = named_step(validate, "Download protected Check projection")
  check(projection_download.fetch("uses").start_with?(DOWNLOAD) &&
        projection_download.dig("with", "artifact-ids") ==
          "${{ steps.provenance.outputs.artifact-id }}" &&
        projection_download.dig("with", "run-id") ==
          "${{ steps.provenance.outputs.run-id }}" &&
        projection_download.dig("with", "github-token") == "${{ github.token }}" &&
        projection_download.dig("with", "merge-multiple") == true,
        "gate does not download the exact protected-run projection artifact")
  final = named_step(validate, "Reproject and validate protected Check provenance")
  check(!final.key?("if") && final["continue-on-error"] != true,
        "final protected evidence validation must be unconditional")
  final_source = final.fetch("run")
  check(final_source.include?("check-projection project") &&
        final_source.include?("cmp -s") &&
        final_source.include?("published_conclusion == \"success\"") &&
        final_source.include?("computed_conclusion == \"success\"") &&
        final_source.include?("staging_problem") &&
        !final_source.include?("SYNTHETIC_MERGE_SHA"),
        "final gate does not reproject exact protected success")

  validate.fetch("steps").each do |step|
    if step.fetch("uses", "").start_with?("./")
      check(step.fetch("uses").start_with?("./abi-staging-authority/"),
            "gate uses candidate-controlled local action")
    end
    source = step.fetch("run", "")
    check(!source.match?(%r{(?:bash|source|\.)\s+[^\n]*abi-staging-exact-head}),
          "gate executes candidate-head code outside the read-only structural job")
  end
end

def deep_copy(value)
  Marshal.load(Marshal.dump(value))
end

def rejected_mutation(workflow, label)
  mutated = deep_copy(workflow)
  yield mutated
  begin
    check_workflow(mutated)
  rescue RuntimeError, KeyError, NoMethodError
    return
  end
  raise "mutation escaped checker: #{label}"
end

begin
  workflow = YAML.safe_load(File.read(WORKFLOW), permitted_classes: [], aliases: false)
  check_workflow(workflow)
  mutations = {
    "workflow write" => lambda { |copy| copy["permissions"] = {"checks" => "write"} },
    "candidate execution" => lambda { |copy|
      copy.dig("jobs", "collect-project", "steps").last["run"] = "bash exact-head/build.sh"
    },
    "collector write" => lambda { |copy|
      copy.dig("jobs", "collect-project", "permissions")["checks"] = "write"
    },
    "publisher candidate checkout" => lambda { |copy|
      copy.dig("jobs", "publish-check", "steps") << {
        "name" => "Untrusted", "run" => "source exact-head/script.sh"
      }
    },
    "missing projection revalidation" => lambda { |copy|
      step = copy.dig("jobs", "publish-check", "steps").find do |item|
        item["run"]&.include?("check-projection project")
      end
      step["run"] = step.fetch("run").gsub("check-projection project", "echo trust")
    },
    "timestamp selection" => lambda { |copy|
      copy.dig("jobs", "collect-project", "steps").last["run"] = "sort -k created_at"
    },
    "background gate" => lambda { |copy|
      copy.dig("jobs", "publish-check", "steps").last["run"] = "test background = success"
    },
    "swallowed write" => lambda { |copy|
      copy.dig("jobs", "publish-check", "steps").last["continue-on-error"] = true
    },
    "mutable artifact name" => lambda { |copy|
      step = copy.dig("jobs", "collect-project", "steps").find { |item| item["uses"]&.start_with?(UPLOAD) }
      step.fetch("with")["name"] = "abi-staging-pr-check-latest"
    },
    "first-page artifact selection" => lambda { |copy|
      step = copy.dig("jobs", "publish-check", "steps").find do |item|
        item["name"] == "Locate exact projection artifact"
      end
      step["run"] = step.fetch("run").gsub(
        "[.[].artifacts[]][0]", ".[0].artifacts[0]"
      )
    },
    "persisted candidate credential" => lambda { |copy|
      step = copy.dig("jobs", "collect-project", "steps").find do |item|
        item["name"] == "Checkout inert exact PR head"
      end
      step.fetch("with")["persist-credentials"] = true
    },
    "missing exact musl materialization" => lambda { |copy|
      copy.dig("jobs", "collect-project", "steps").reject! do |step|
        step["name"] == "Materialize exact musl gitlink as inert data"
      end
    },
    "candidate-controlled musl materialization" => lambda { |copy|
      step = copy.dig("jobs", "collect-project", "steps").find do |item|
        item["name"] == "Materialize exact musl gitlink as inert data"
      end
      step["run"] = "git -C exact-head submodule update --init libc/musl"
    },
    "collector target validation after use" => lambda { |copy|
      step = copy.dig("jobs", "collect-project", "steps").find do |item|
        item["run"]&.include?("host_target=$(cd authority &&")
      end
      validation = '[[ "$host_target" =~ ^[A-Za-z0-9_.-]+$ ]]'
      assignment =
        'authority_xtask="$GITHUB_WORKSPACE/authority/target/$host_target/debug/xtask"'
      step["run"] = step.fetch("run")
        .sub("#{validation}\n", "")
        .sub(assignment, "#{assignment}\n#{validation}")
    },
    "collector target filtering inside dev shell" => lambda { |copy|
      step = copy.dig("jobs", "collect-project", "steps").find do |item|
        item["run"]&.include?("host_target=$(cd authority &&")
      end
      step["run"] = step.fetch("run").sub(
        "bash scripts/dev-shell.sh rustc -vV |\n" \
          "    awk '/^host: / { print $2 }')",
        "bash scripts/dev-shell.sh bash -c \\\n" \
          "    \"rustc -vV | awk '/^host: / { print \\\$2 }'\")"
      )
    },
    "missing publisher target validation" => lambda { |copy|
      step = copy.dig("jobs", "publish-check", "steps").find do |item|
        item["run"]&.include?("host_target=$(cd authority &&")
      end
      step["run"] = step.fetch("run").sub(
        "[[ \"$host_target\" =~ ^[A-Za-z0-9_.-]+$ ]]\n", ""
      )
    }
  }
  mutations.each { |label, mutation| rejected_mutation(workflow, label, &mutation) }

  merge_gate = YAML.safe_load(
    File.read(MERGE_GATE), permitted_classes: [], aliases: false
  )
  check_merge_gate(merge_gate)
  merge_mutations = {
    "PR-controlled trigger" => lambda { |copy|
      copy["on"] = {"pull_request" => {"types" => ["labeled"]}}
    },
    "write-capable gate" => lambda { |copy|
      copy.dig("jobs", "validate-current-evidence", "permissions")["checks"] = "write"
    },
    "synthetic structural head" => lambda { |copy|
      step = copy.dig("jobs", "abi-staging-exact-head-structure", "steps").find do |item|
        item["name"] == "Checkout exact PR head for structural ABI check"
      end
      step.fetch("with")["ref"] = "refs/pull/19/merge"
    },
    "missing gate musl materialization" => lambda { |copy|
      copy.dig("jobs", "validate-current-evidence", "steps").reject! do |step|
        step["name"] == "Materialize exact musl gitlink as inert data"
      end
    },
    "candidate-controlled gate musl materialization" => lambda { |copy|
      step = copy.dig("jobs", "validate-current-evidence", "steps").find do |item|
        item["name"] == "Materialize exact musl gitlink as inert data"
      end
      step["run"] =
        "git -C abi-staging-exact-head submodule update --init libc/musl"
    },
    "gate musl materialization after request derivation" => lambda { |copy|
      steps = copy.dig("jobs", "validate-current-evidence", "steps")
      materialization = steps.delete_at(steps.index do |step|
        step["name"] == "Materialize exact musl gitlink as inert data"
      end)
      provenance_index = steps.index do |step|
        step["name"] ==
          "Validate current request and locate protected Check provenance"
      end
      steps.insert(provenance_index + 1, materialization)
    },
    "latest-only Check inventory" => lambda { |copy|
      step = copy.dig("jobs", "validate-current-evidence", "steps").find do |item|
        item["name"] == "Validate current request and locate protected Check provenance"
      end
      step["run"] = step.fetch("run").gsub("&filter=all", "")
    },
    "unbound publisher run" => lambda { |copy|
      step = copy.dig("jobs", "validate-current-evidence", "steps").find do |item|
        item["name"] == "Validate current request and locate protected Check provenance"
      end
      step["run"] = step.fetch("run").gsub(
        '.path == ".github/workflows/abi-staging-pr-check.yml@main"', "true"
      )
    },
    "first-page protected artifact" => lambda { |copy|
      step = copy.dig("jobs", "validate-current-evidence", "steps").find do |item|
        item["name"] == "Validate current request and locate protected Check provenance"
      end
      step["run"] = step.fetch("run").gsub(
        "[.[].artifacts[]][0]", ".[0].artifacts[0]"
      )
    },
    "candidate local action" => lambda { |copy|
      copy.dig("jobs", "validate-current-evidence", "steps") << {
        "name" => "Candidate action", "uses" => "./abi-staging-exact-head/.github/action"
      }
    },
    "candidate local action in structural job" => lambda { |copy|
      copy.dig("jobs", "abi-staging-exact-head-structure", "steps") << {
        "name" => "Candidate action", "uses" => "./abi-staging-exact-head/.github/action"
      }
    },
    "second candidate structural execution" => lambda { |copy|
      copy.dig("jobs", "abi-staging-exact-head-structure", "steps") << {
        "name" => "Second candidate execution",
        "run" => "bash abi-staging-exact-head/scripts/check-abi-version.sh"
      }
    },
    "separate candidate execution" => lambda { |copy|
      copy.dig("jobs", "validate-current-evidence", "steps") << {
        "name" => "Candidate execution", "run" => "bash abi-staging-exact-head/build.sh"
      }
    },
    "conditional final validation" => lambda { |copy|
      step = copy.dig("jobs", "validate-current-evidence", "steps").find do |item|
        item["name"] == "Reproject and validate protected Check provenance"
      end
      step["if"] = "${{ success() }}"
    },
    "swallowed provenance validation" => lambda { |copy|
      step = copy.dig("jobs", "validate-current-evidence", "steps").find do |item|
        item["name"] == "Validate current request and locate protected Check provenance"
      end
      step["continue-on-error"] = true
    },
    "merge target validation after use" => lambda { |copy|
      step = copy.dig("jobs", "validate-current-evidence", "steps").find do |item|
        item["run"]&.include?("host_target=$(cd \"$authority\" &&")
      end
      validation = '[[ "$host_target" =~ ^[A-Za-z0-9_.-]+$ ]]'
      assignment = 'authority_xtask="$authority/target/$host_target/debug/xtask"'
      step["run"] = step.fetch("run")
        .sub("#{validation}\n", "")
        .sub(assignment, "#{assignment}\n#{validation}")
    }
  }
  merge_mutations.each do |label, mutation|
    mutated = deep_copy(merge_gate)
    mutation.call(mutated)
    begin
      check_merge_gate(mutated)
    rescue RuntimeError, KeyError, NoMethodError
      next
    end
    raise "merge-gate mutation escaped checker: #{label}"
  end
  puts "check-abi-staging-pr-check-workflow: PASS"
rescue Errno::ENOENT, KeyError, NoMethodError, Psych::Exception, RuntimeError => e
  warn "check-abi-staging-pr-check-workflow: #{e.message}"
  exit 1
end
