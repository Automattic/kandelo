#!/usr/bin/env ruby
# frozen_string_literal: true

require "yaml"

ROOT = File.expand_path("..", __dir__)
WORKFLOW = ARGV.empty? ?
  File.join(ROOT, ".github/workflows/abi-staging-pr-check.yml") :
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
  check(trigger.dig("pull_request_target", "types") == %w[opened synchronize reopened],
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
  check(!collect_source.match?(%r{(?:bash|source|\.)\s+[^\n]*exact-head}),
        "collector executes candidate-head code")
  check(!collect.fetch("env", {}).key?("GH_TOKEN"),
        "collector exposes GitHub credentials job-wide")
  candidate_checkout = named_step(collect, "Checkout inert exact PR head")
  check(candidate_checkout.fetch("uses").start_with?(CHECKOUT) &&
        candidate_checkout.dig("with", "ref") == "${{ matrix.subject.head }}" &&
        candidate_checkout.dig("with", "path") == "exact-head",
        "collector does not check out the exact PR head as inert data")
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
        publish_source.include?("required-check-activation.toml") &&
        publish_source.include?("artifact-ids") == false,
        "publisher does not reproject and use the narrow update adapter")
  check(!publish_source.match?(%r{(?:bash|source|\.)\s+[^\n]*exact-head}),
        "publisher executes candidate-head code")
  download = named_step(publish, "Download exact projection artifact")
  check(download.fetch("uses").start_with?(DOWNLOAD) &&
        download.dig("with", "artifact-ids") == "${{ steps.locate.outputs.artifact-id }}" &&
        download.dig("with", "merge-multiple") == true,
        "publisher does not download the exact located artifact ID")
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
    "persisted candidate credential" => lambda { |copy|
      step = copy.dig("jobs", "collect-project", "steps").find do |item|
        item["name"] == "Checkout inert exact PR head"
      end
      step.fetch("with")["persist-credentials"] = true
    }
  }
  mutations.each { |label, mutation| rejected_mutation(workflow, label, &mutation) }
  puts "check-abi-staging-pr-check-workflow: PASS"
rescue Errno::ENOENT, KeyError, NoMethodError, Psych::Exception, RuntimeError => e
  warn "check-abi-staging-pr-check-workflow: #{e.message}"
  exit 1
end
