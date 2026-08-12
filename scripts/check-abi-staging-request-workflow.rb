#!/usr/bin/env ruby
# frozen_string_literal: true

require "yaml"

ROOT = File.expand_path("..", __dir__)
WORKFLOW = ARGV.empty? ?
  File.join(ROOT, ".github/workflows/abi-staging-request-feed.yml") :
  File.expand_path(ARGV.fetch(0))

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
  check(trigger.keys.sort == %w[pull_request_target push schedule workflow_dispatch],
        "request feed triggers changed")
  check(trigger.dig("pull_request_target", "types") == %w[opened synchronize reopened],
        "pull_request_target events changed")
  check(trigger.dig("push", "branches") == ["main"],
        "policy repair push must target protected main")
  push_paths = trigger.dig("push", "paths")
  check(push_paths.is_a?(Array) &&
        push_paths.include?("abi/staging/request-policy.toml") &&
        push_paths.include?("images/vfs/products/**") &&
        push_paths.include?(".github/workflows/abi-staging-request-feed.yml"),
        "policy repair push paths are incomplete")
  schedules = trigger.fetch("schedule")
  check(schedules.is_a?(Array) && schedules.length == 1 &&
        schedules.fetch(0).keys == ["cron"],
        "daily repair schedule changed")
  input = trigger.dig("workflow_dispatch", "inputs", "pull-request-number")
  check(input.is_a?(Hash) && input["required"] == false && input["type"] == "string",
        "manual repair must accept one optional PR number")

  jobs = workflow.fetch("jobs")
  check(jobs.keys == %w[classify-exact-head derive-request publish-request],
        "request feed must contain the three reviewed jobs in order")
  classify = jobs.fetch("classify-exact-head")
  derive = jobs.fetch("derive-request")
  publish = jobs.fetch("publish-request")
  check(classify.fetch("permissions") == {"contents" => "read"},
        "classification permissions changed")
  check(derive.fetch("permissions") == {"contents" => "read"},
        "derivation permissions changed")
  check(publish.fetch("permissions") == {"actions" => "read", "contents" => "write"},
        "publisher permissions changed")
  check(Array(derive.fetch("needs")) == ["classify-exact-head"],
        "derivation dependency changed")
  check(Array(publish.fetch("needs")) == %w[classify-exact-head derive-request],
        "publisher dependency changed")
  check(classify.dig("outputs", "protected-sha") ==
          "${{ steps.resolve.outputs.protected-sha }}" &&
        classify.dig("outputs", "subjects-sha256") ==
          "${{ steps.resolve.outputs.subjects-sha256 }}",
        "classification outputs do not bind protected authority and subjects")
  jobs.each do |name, job|
    check(job.fetch("timeout-minutes").between?(1, 120), "#{name} timeout is invalid")
    check(job.fetch("steps").none? { |step| step["continue-on-error"] == true },
          "#{name} may swallow a failed trust boundary")
  end

  check_actions(workflow)
  flattened = values(workflow).join("\n")
  check(!flattened.match?(/\bsecrets\b/i), "request workflow may not use secrets")
  check(!flattened.include?("refs/pull/") && !flattened.include?("/merge"),
        "request workflow may not select a synthetic merge ref")
  check(!flattened.match?(/git\s+merge\b/), "request workflow may not synthesize a merge")
  check(!flattened.include?("--clobber"), "request workflow may not clobber an asset")
  check(!flattened.match?(/latest\.json|current\.json/),
        "request workflow may not use a mutable request alias")
  check(!flattened.match?(/sort.*(?:created_at|updated_at|timestamp|asset_id)/i),
        "request workflow may not select requests by ordering metadata")

  classify_source = run_source(classify)
  check(classify.fetch("steps").first.fetch("env", {}).fetch("EVENT_HEAD", nil) ==
          "${{ github.event.pull_request.head.sha }}" &&
        classify.fetch("steps").first.fetch("env", {}).fetch("DEFAULT_BRANCH", nil) ==
          "${{ github.event.repository.default_branch }}" &&
        classify_source.include?('[[ $DEFAULT_BRANCH == main ]]') &&
        classify_source.include?("head.repo.full_name") &&
        classify_source.include?("same-repository-only") &&
        classify_source.include?("env -u GH_TOKEN -u GITHUB_TOKEN") &&
        classify_source.include?("env -i") &&
        classify_source.include?('HOME="$candidate_home"') &&
        classify_source.include?('env ABI_CHECK_BASE_REF="$PROTECTED_SHA"') &&
        classify_source.include?("head -c 1048576") &&
        classify_source.include?("scripts/check-abi-version.sh") &&
        classify_source.include?("structural-report.json") &&
        classify_source.include?("HEAD^{tree}"),
        "classification does not bind and check each uncredentialed exact head")
  check(!classify_source.match?(/gh\s+(?:release|api\s+--method)/),
        "classification may not write through GitHub")
  check(!classify.fetch("env", {}).key?("GH_TOKEN"),
        "classification job may not expose GH_TOKEN to candidate execution")

  derive_source = run_source(derive)
  check(derive_source.include?("request-policy check") &&
        derive_source.include?("structural-report validate") &&
        derive_source.include?("previous_abi=$(sed -nE") &&
        derive_source.include?("--previous-abi \"$previous_abi\"") &&
        derive_source.include?("git -C \"$exact_head_data\" diff --name-only -z") &&
        derive_source.include?("request classify") &&
        derive_source.include?("--changed-paths") &&
        derive_source.include?("request derive") &&
        derive_source.include?("request plan-feed-write") &&
        derive_source.include?("env -u GH_TOKEN -u GITHUB_TOKEN git") &&
        derive_source.include?("exact-head-data") &&
        derive_source.include?("SUBJECTS_SHA256") &&
        derive_source.include?("subjects.json") &&
        !derive_source.include?('find "$evidence/reports"') &&
        derive_source.include?("authority_xtask"),
        "protected derivation does not revalidate inert exact-head data")
  check_filtered_host_target(derive_source, "protected derivation")
  check(!derive_source.match?(%r{(?:bash|source|\.)\s+[^\n]*exact-head-data}),
        "protected derivation executes a file from the exact head")
  derive_download = named_step(derive, "Download structural evidence")
  check(derive_download.fetch("uses").start_with?(DOWNLOAD) &&
        derive_download.dig("with", "name") ==
          "abi-staging-structural-${{ github.run_id }}",
        "derivation downloads an unreviewed artifact inventory")
  classify_upload = named_step(classify, "Transfer bounded structural evidence")
  check(classify_upload.fetch("uses").start_with?(UPLOAD) &&
        classify_upload.dig("with", "name") ==
          "abi-staging-structural-${{ github.run_id }}" &&
        classify_upload.dig("with", "path").include?("subjects.json") &&
        classify_upload.dig("with", "path").include?("*-pull-request.json") &&
        classify_upload.dig("with", "path").include?("*-structural-report.json") &&
        !classify_upload.dig("with", "path").include?("check.log"),
        "classification artifact identity changed")

  publish_source = run_source(publish)
  check(publish_source.include?("request-policy check") &&
        publish_source.include?("request validate-feed-plan") &&
        publish_source.include?("request-feed-activation.toml") &&
        publish_source.include?("$mode == observe") &&
        publish_source.include?("publish-abi-staging-request.sh") &&
        publish_source.include?("GH_TOKEN=\"$GITHUB_TOKEN\"") &&
        publish_source.include?("Public nonendorsed candidate request") &&
        publish_source.include?("set -euo pipefail"),
        "publisher does not strictly revalidate and honor observe mode")
  check_filtered_host_target(publish_source, "publisher")
  check(!publish_source.match?(%r{(?:bash|source|\.)\s+[^\n]*exact-head}),
        "publisher executes candidate-head code")
  publish_download = named_step(publish, "Download derived requests")
  check(publish_download.fetch("uses").start_with?(DOWNLOAD) &&
        publish_download.dig("with", "name") ==
          "abi-staging-derived-${{ github.run_id }}",
        "publisher downloads an unreviewed artifact inventory")
  derive_upload = named_step(derive, "Transfer canonical derived requests")
  check(derive_upload.fetch("uses").start_with?(UPLOAD) &&
        derive_upload.dig("with", "name") ==
          "abi-staging-derived-${{ github.run_id }}",
        "derived artifact identity changed")
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
    "synthetic merge" => lambda { |copy|
      copy.dig("jobs", "classify-exact-head", "steps").first["run"] =
        "git fetch origin refs/pull/1/merge"
    },
    "merge command" => lambda { |copy|
      copy.dig("jobs", "classify-exact-head", "steps").first["run"] = "git merge origin/main"
    },
    "classification write" => lambda { |copy|
      copy.dig("jobs", "classify-exact-head", "permissions")["contents"] = "write"
    },
    "candidate token" => lambda { |copy|
      copy.dig("jobs", "classify-exact-head")["env"] = {"GH_TOKEN" => "${{ github.token }}"}
    },
    "persisted checkout credential" => lambda { |copy|
      step = copy.dig("jobs", "derive-request", "steps").find { |item| item["uses"]&.start_with?(CHECKOUT) }
      step.fetch("with")["persist-credentials"] = true
    },
    "candidate execution in writer" => lambda { |copy|
      copy.dig("jobs", "publish-request", "steps").last["run"] = "bash exact-head/script.sh"
    },
    "missing inert revalidation" => lambda { |copy|
      step = copy.dig("jobs", "derive-request", "steps").find { |item| item["run"]&.include?("structural-report validate") }
      step["run"] = step.fetch("run").gsub("structural-report validate", "echo trust-report")
    },
    "line-delimited path classification" => lambda { |copy|
      step = copy.dig("jobs", "derive-request", "steps").find do |item|
        item["run"]&.include?("request classify")
      end
      step["run"] = step.fetch("run")
        .gsub("diff --name-only -z", "diff --name-only")
        .gsub("request classify", "echo classify")
    },
    "unbound subject inventory" => lambda { |copy|
      copy.dig("jobs", "classify-exact-head", "outputs").delete("subjects-sha256")
    },
    "clobber" => lambda { |copy|
      copy.dig("jobs", "publish-request", "steps").last["run"] += "\ngh release upload --clobber"
    },
    "timestamp selection" => lambda { |copy|
      copy.dig("jobs", "derive-request", "steps").last["run"] = "sort -k created_at"
    },
    "fork enablement" => lambda { |copy|
      step = copy.dig("jobs", "classify-exact-head", "steps").find { |item| item["run"]&.include?("same-repository-only") }
      step["run"] = step.fetch("run").gsub("same-repository-only", "fork-enabled")
    },
    "swallowed failure" => lambda { |copy|
      copy.dig("jobs", "publish-request", "steps").last["continue-on-error"] = true
    },
    "derivation target validation after use" => lambda { |copy|
      step = copy.dig("jobs", "derive-request", "steps").find do |item|
        item["run"]&.include?("host_target=$(cd authority &&")
      end
      validation = '[[ "$host_target" =~ ^[A-Za-z0-9_.-]+$ ]]'
      assignment =
        'authority_xtask="$GITHUB_WORKSPACE/authority/target/$host_target/debug/xtask"'
      step["run"] = step.fetch("run")
        .sub("#{validation}\n", "")
        .sub(assignment, "#{assignment}\n#{validation}")
    }
  }
  mutations.each { |label, mutation| rejected_mutation(workflow, label, &mutation) }
  puts "check-abi-staging-request-workflow: PASS"
rescue Errno::ENOENT, KeyError, NoMethodError, Psych::Exception, RuntimeError => e
  warn "check-abi-staging-request-workflow: #{e.message}"
  exit 1
end
