#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "find"
require "json"
require "pathname"

MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_API_FILE_BYTES = 128 * 1024 * 1024
MAX_API_TOTAL_BYTES = 256 * 1024 * 1024
MAX_API_FILES = 64
MAX_SOURCE_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024
MAX_SOURCE_RUNTIME_ENTRIES = 100_000
MAX_SOURCE_TREE_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_SOURCE_TREE_BYTES = 2 * 1024 * 1024 * 1024
MAX_SOURCE_TREE_ENTRIES = 100_000
NAME_PATTERN = /\A[a-z0-9][a-z0-9+@._-]{0,254}\z/
TARGET_TAG = "x86_64_linux"

def fail_contract(message)
  warn "homebrew-native-api-contract: #{message}"
  exit 2
end

def canonical_json(value)
  sorted = case value
  when Hash
    value.keys.sort.to_h { |key| [key, canonical_json(value.fetch(key))] }
  when Array
    value.map { |entry| canonical_json(entry) }
  else
    value
  end
  sorted
end

def write_json(path, value)
  bytes = "#{JSON.pretty_generate(canonical_json(value))}\n"
  File.open(path, File::WRONLY | File::CREAT | File::EXCL, 0o600) do |file|
    fail_contract("#{path} is not a regular file") unless file.stat.file?
    file.write(bytes)
    file.flush
    file.fsync
  end
rescue Errno::EEXIST, Errno::ELOOP => e
  fail_contract("refusing to replace #{path}: #{e.message}")
end

def read_json(path)
  stat = File.lstat(path)
  fail_contract("#{path} is not a regular file") unless stat.file?
  fail_contract("#{path} exceeds the size limit") if stat.size > MAX_JSON_BYTES
  JSON.parse(File.read(path, encoding: Encoding::UTF_8))
rescue Errno::ENOENT, JSON::ParserError => e
  fail_contract("cannot read #{path}: #{e.message}")
end

def read_names(path)
  stat = File.lstat(path)
  fail_contract("#{path} is not a regular file") unless stat.file?
  fail_contract("#{path} exceeds the size limit") if stat.size > 65_536
  names = File.readlines(path, chomp: true, encoding: Encoding::UTF_8)
  fail_contract("#{path} contains an invalid Formula name") unless names.all? { |name| NAME_PATTERN.match?(name) }
  fail_contract("#{path} must be sorted and unique") unless names == names.sort.uniq
  fail_contract("#{path} contains too many Formula names") if names.length > 256
  names
rescue Errno::ENOENT => e
  fail_contract("cannot read #{path}: #{e.message}")
end

def source_identity(stat)
  [
    stat.dev, stat.ino, stat.mode, stat.nlink, stat.size,
    stat.mtime.to_i, stat.mtime.nsec, stat.ctime.to_i, stat.ctime.nsec
  ]
end

def source_runtime_inventory(repository)
  runtime_relative = "Library/Homebrew/vendor/portable-ruby"
  runtime_root = repository/runtime_relative
  empty_digest = Digest::SHA256.hexdigest(JSON.generate([]))
  return {
    "path" => runtime_relative,
    "present" => false,
    "entries" => 0,
    "bytes" => 0,
    "sha256" => empty_digest,
  } unless runtime_root.exist? || runtime_root.symlink?

  fail_contract("ignored portable Ruby root is not a real directory") unless
    runtime_root.directory? && !runtime_root.symlink?

  entries = []
  total_bytes = 0
  Find.find(runtime_root.to_s) do |path_string|
    path = Pathname(path_string)
    before = path.lstat
    relative = path.relative_path_from(repository).to_s
    record = {
      "path" => relative,
      "mode" => before.mode & 0o7777,
    }
    if before.directory?
      record["type"] = "directory"
    elsif before.file?
      record["type"] = "file"
      record["bytes"] = before.size
      record["sha256"] = Digest::SHA256.file(path).hexdigest
      total_bytes += before.size
    elsif before.symlink?
      target = path.readlink.to_s
      resolved = path.realpath
      unless resolved == runtime_root ||
             resolved.to_s.start_with?("#{runtime_root}/")
        fail_contract("ignored portable Ruby symlink escapes its runtime")
      end
      record["type"] = "symlink"
      record["target"] = target
    else
      fail_contract("ignored portable Ruby contains an unsafe filesystem entry")
    end
    after = path.lstat
    fail_contract("ignored portable Ruby changed during attestation") unless
      source_identity(before) == source_identity(after)
    entries << record
    fail_contract("ignored portable Ruby contains too many entries") if
      entries.length > MAX_SOURCE_RUNTIME_ENTRIES
    fail_contract("ignored portable Ruby exceeds the size limit") if
      total_bytes > MAX_SOURCE_RUNTIME_BYTES
  end
  entries.sort_by! { |entry| entry.fetch("path").b }
  {
    "path" => runtime_relative,
    "present" => true,
    "entries" => entries.length,
    "bytes" => total_bytes,
    "sha256" => Digest::SHA256.hexdigest(
      JSON.generate(canonical_json(entries))
    ),
  }
rescue Errno::ENOENT, Errno::ELOOP => e
  fail_contract("cannot inventory ignored portable Ruby: #{e.message}")
end

def git_blob_sha1(path, before)
  digest = Digest::SHA1.new
  digest.update("blob #{before.size}\0")
  bytes = 0
  File.open(path, "rb") do |file|
    while (chunk = file.read(1024 * 1024))
      bytes += chunk.bytesize
      digest.update(chunk)
    end
  end
  fail_contract("tracked Homebrew source changed during attestation") unless
    bytes == before.size
  digest.hexdigest
end

def tracked_source_inventory(repository, manifest_path)
  manifest_stat = File.lstat(manifest_path)
  fail_contract("tracked source manifest is not a regular file") unless
    manifest_stat.file?
  if manifest_stat.size > MAX_SOURCE_TREE_MANIFEST_BYTES
    fail_contract("tracked source manifest exceeds the size limit")
  end

  manifest = File.binread(manifest_path)
  manifest_after = File.lstat(manifest_path)
  unless source_identity(manifest_stat) == source_identity(manifest_after)
    fail_contract("tracked source manifest changed during attestation")
  end
  records = manifest.split("\0", -1)
  fail_contract("tracked source manifest is not NUL terminated") unless
    records.pop == ""

  aggregate = Digest::SHA256.new
  seen = {}
  total_bytes = 0
  entries = 0

  records.each do |record|
    metadata, relative = record.split("\t", 2)
    mode, type, object = metadata.to_s.split(" ", 3)
    unless relative && !relative.empty? &&
           /\A[0-9a-f]{40}\z/.match?(object.to_s) &&
           !relative.start_with?("/") &&
           relative.split("/").none? { |part| part.empty? || part == "." ||
             part == ".." }
      fail_contract("tracked source manifest contains an invalid entry")
    end
    fail_contract("tracked source manifest repeats a path") if seen[relative]
    seen[relative] = true

    path = repository.join(relative)
    before = path.lstat
    case [mode, type]
    when ["040000", "tree"]
      fail_contract("tracked Homebrew source directory changed type") unless
        before.directory? && !before.symlink?
    when ["100644", "blob"], ["100755", "blob"]
      fail_contract("tracked Homebrew source file changed type") unless
        before.file? && !before.symlink?
      executable = (before.mode & 0o111).positive?
      expected_executable = mode == "100755"
      unless executable == expected_executable
        fail_contract("tracked Homebrew source executable mode changed")
      end
      unless git_blob_sha1(path, before) == object
        fail_contract("tracked Homebrew source bytes differ from Git tree")
      end
      total_bytes += before.size
    when ["120000", "blob"]
      fail_contract("tracked Homebrew source symlink changed type") unless
        before.symlink?
      target = path.readlink.to_s.b
      digest = Digest::SHA1.hexdigest("blob #{target.bytesize}\0#{target}")
      unless digest == object
        fail_contract("tracked Homebrew source symlink target changed")
      end
      total_bytes += target.bytesize
    else
      fail_contract("tracked source manifest contains an unsupported entry")
    end

    after = path.lstat
    unless source_identity(before) == source_identity(after)
      fail_contract("tracked Homebrew source changed during attestation")
    end
    entries += 1
    if entries > MAX_SOURCE_TREE_ENTRIES
      fail_contract("tracked Homebrew source contains too many entries")
    end
    if total_bytes > MAX_SOURCE_TREE_BYTES
      fail_contract("tracked Homebrew source exceeds the size limit")
    end
    aggregate.update([relative.bytesize].pack("Q>"))
    aggregate.update(relative.b)
    aggregate.update("\0#{mode}\0#{type}\0#{object}\0")
  rescue Errno::ENOENT, Errno::ELOOP => e
    fail_contract("cannot inventory tracked Homebrew source: #{e.message}")
  end

  {
    "entries" => entries,
    "bytes" => total_bytes,
    "sha256" => aggregate.hexdigest,
  }
rescue Errno::ENOENT, Errno::ELOOP => e
  fail_contract("cannot read tracked source manifest: #{e.message}")
end

def api_inventory
  require "api"
  root = Homebrew::API::HOMEBREW_CACHE_API
  fail_contract("Homebrew API cache is missing") unless root.directory? && !root.symlink?

  files = []
  total = 0
  Find.find(root.to_s) do |path_string|
    path = Pathname(path_string)
    stat = path.lstat
    next if path == root || stat.directory?

    fail_contract("API cache contains a non-regular file: #{path}") unless stat.file?
    fail_contract("API cache file exceeds the size limit: #{path}") if stat.size > MAX_API_FILE_BYTES
    relative = path.relative_path_from(root).to_s
    total += stat.size
    files << {
      "path" => relative,
      "bytes" => stat.size,
      "sha256" => Digest::SHA256.file(path).hexdigest,
    }
  end
  fail_contract("API cache contains too many files") if files.length > MAX_API_FILES
  fail_contract("API cache exceeds the total size limit") if total > MAX_API_TOTAL_BYTES

  required = [
    "formula.jws.json",
    "formula_aliases.txt",
    "formula_names.txt",
    "internal/executables.txt",
    "internal/packages.x86_64_linux.jws.json",
  ]
  paths = files.map { |entry| entry.fetch("path") }
  fail_contract("API cache is incomplete") unless (required - paths).empty?
  files.sort_by { |entry| entry.fetch("path") }
end

def check_api_seal
  require "api"
  root = Homebrew::API::HOMEBREW_CACHE_API
  expected_uid = 0
  if ENV["HOMEBREW_KANDELO_NATIVE_CONTRACT_TESTING"] == "1" &&
     ENV["GITHUB_ACTIONS"] != "true"
    expected_uid = Process.uid
  end

  Find.find(root.to_s) do |path_string|
    path = Pathname(path_string)
    stat = path.lstat
    expected_mode = stat.directory? ? 0o555 : 0o444
    fail_contract("sealed API path has an invalid type: #{path}") unless
      stat.directory? || stat.file?
    fail_contract("sealed API path is not owned by the trusted identity: #{path}") unless
      stat.uid == expected_uid
    fail_contract("sealed API path has mutable permissions: #{path}") unless
      (stat.mode & 0o777) == expected_mode
  end
end

def current_brew_commit
  require "env_config"
  require "utils/popen"
  repository = HOMEBREW_REPOSITORY.to_s
  # WHY: the publisher deliberately keeps the sealed Homebrew checkout owned
  # by the workflow identity, not the isolated build identity. Git rejects
  # that cross-user checkout by default. Authorize only this exact read-only
  # provenance query; native Brew commands do not receive general Git trust.
  git_environment = {
    "GIT_CONFIG_NOSYSTEM" => "1",
    "GIT_CONFIG_GLOBAL" => File::NULL,
    "GIT_CONFIG_COUNT" => "1",
    "GIT_CONFIG_KEY_0" => "safe.directory",
    "GIT_CONFIG_VALUE_0" => repository,
    "GIT_NO_REPLACE_OBJECTS" => "1",
    "GIT_OPTIONAL_LOCKS" => "0",
  }
  actual = Utils.safe_popen_read(
    git_environment,
    Homebrew::EnvConfig.git_path,
    "-C", repository,
    "rev-parse", "--verify", "HEAD^{commit}"
  ).strip
  fail_contract("protected Git returned an invalid Homebrew commit") unless
    /\A[0-9a-f]{40}\z/.match?(actual)
  actual
rescue ErrorDuringExecution => e
  status = e.exitstatus || "unknown"
  fail_contract(
    "cannot verify Homebrew checkout with protected Git (status #{status})"
  )
end

def check_brew_commit(expected)
  fail_contract("expected Homebrew commit is invalid") unless /\A[0-9a-f]{40}\z/.match?(expected)
  actual = current_brew_commit
  fail_contract("Homebrew checkout is #{actual}, expected #{expected}") unless actual == expected
end

def with_target_api
  require "simulate_system"
  ENV.delete("HOMEBREW_NO_INSTALL_FROM_API")
  Homebrew::SimulateSystem.with(os: :linux, arch: :intel) { yield }
end

def prime_api
  with_target_api do
    require "api"
    require "api/formula"
    require "api/internal"

    Homebrew::API.fetch_api_files!
    Homebrew::API::Formula.all_formulae
    Homebrew::API::Formula.write_names_and_aliases(regenerate: true)
    Homebrew::API::Internal.formula_hashes
    # WHY: Homebrew writes these helpers lazily. Generate the final internal-API
    # view before the cache becomes read-only so later name resolution has no
    # mutable alias or executable side channel.
    Homebrew::API::Internal.write_formula_names_and_aliases(regenerate: true)
  end
end

def selected_records(names)
  with_target_api do
    require "api"
    require "api/formula"
    require "api/formula/formula_struct_generator"
    require "api/internal"
    require "utils/bottles"

    public_records = Homebrew::API::Formula.all_formulae
    internal_records = Homebrew::API::Internal.formula_hashes
    tag = Utils::Bottles::Tag.from_symbol(TARGET_TAG.to_sym)
    names.to_h do |name|
      public_record = Homebrew::API::Formula::FormulaStructGenerator
        .generate_formula_struct_hash(
        public_records.fetch(name),
        bottle_tag: tag
      ).serialize(bottle_tag: tag)
      # WHY: exact Homebrew's FormulaStruct projection removes global tap
      # motion,
      # all-platform variations, and unrelated bottle tags while retaining
      # every field this exact Homebrew can consume for x86_64 Linux.
      # Caveats are presentation text and Homebrew expands their prefix/home
      # placeholders to each random native realm. Service presentation fields
      # do the same and are not consumed while pouring a native build tool.
      # The full internal record still binds both signed sources.
      public_record.delete("caveats")
      public_record.delete("service_args")
      public_record.delete("service_name_args")
      public_record.delete("service_run_args")
      public_record.delete("service_run_kwargs")
      public_record["name"] = name
      internal_record = internal_records.fetch(name).dup
      internal_record["name"] = name
      [
        name,
        {
          "public" => public_record,
          "internal" => internal_record,
        },
      ]
    end
  end
rescue KeyError => e
  fail_contract("signed API omits a selected Formula: #{e.message}")
end

def api_source_provenance
  with_target_api do
    require "api/formula"
    require "api/internal"

    public = Homebrew::API::Formula.all_formulae
    fail_contract("signed public API contains no Formula records") if public.empty?
    public_heads = public.values.map do |record|
      fail_contract("signed public API contains a non-core Formula") unless
        record["tap"] == "homebrew/core"
      record["tap_git_head"]
    end.uniq
    fail_contract("signed public API does not bind one core revision") unless
      public_heads.length == 1 && /\A[0-9a-f]{40}\z/.match?(public_heads.first)

    internal_head = Homebrew::API::Internal.formula_tap_git_head
    fail_contract("signed Homebrew API sources disagree on the core revision") unless
      internal_head == public_heads.first
    {
      "tap" => "homebrew/core",
      "tap_git_head" => internal_head,
    }
  end
end

def validate_policy(policy, expected_commit)
  expected_keys = %w[architecture homebrew_commit kind roots schema]
  fail_contract("root policy has unexpected fields") unless policy.keys.sort == expected_keys
  fail_contract("root policy schema is unsupported") unless policy["schema"] == 1
  fail_contract("root policy kind is invalid") unless policy["kind"] == "kandelo-homebrew-native-roots"
  fail_contract("root policy architecture is invalid") unless policy["architecture"] == TARGET_TAG
  fail_contract("root policy Homebrew commit differs") unless policy["homebrew_commit"] == expected_commit
  roots = policy["roots"]
  fail_contract("root policy purposes are invalid") unless roots.is_a?(Hash) && !roots.empty?
  roots.each do |purpose, names|
    fail_contract("root policy purpose is invalid") unless NAME_PATTERN.match?(purpose)
    fail_contract("root policy names are invalid") unless names.is_a?(Array) &&
      names == names.sort.uniq && names.all? { |name| NAME_PATTERN.match?(name) }
  end
  roots
end

def contract_envelope(expected_commit, purpose, roots, closure, records, inventory,
                      source_provenance)
  {
    "schema" => 1,
    "kind" => "kandelo-homebrew-native-api-attestation",
    "architecture" => TARGET_TAG,
    "homebrew_commit" => expected_commit,
    "purpose" => purpose,
    "roots" => roots,
    "closure" => closure,
    "records_sha256" => Digest::SHA256.hexdigest(
      JSON.generate(canonical_json(records))
    ),
    "source" => source_provenance,
    "api_inventory" => inventory,
  }
end

def audit_cellar(allowed_names, required_names)
  cellar = Pathname(HOMEBREW_CELLAR)
  fail_contract("native Cellar is missing") unless cellar.directory? && !cellar.symlink?
  racks = cellar.children.sort_by { |path| path.basename.to_s }
  fail_contract("native Cellar contains a non-directory rack") unless
    racks.all? { |path| path.directory? && !path.symlink? }
  installed_names = racks.map { |path| path.basename.to_s }
  # WHY: `brew deps --include-implicit` describes every Formula Homebrew may
  # need, not a promise that each one receives a Cellar rack on this host.
  # Let exact Homebrew decide which satisfied implicit dependencies it
  # actually pours, then require every resulting keg to stay inside the
  # admitted closure and every
  # requested top-level tool to exist.
  fail_contract("native Cellar escaped the admitted closure") unless
    (installed_names - allowed_names).empty?
  fail_contract("native Cellar omits a requested Formula") unless
    (required_names - installed_names).empty?

  racks.map do |rack|
    versions = rack.children
    fail_contract("native rack must contain exactly one version: #{rack}") unless
      versions.length == 1 && versions.first.directory? && !versions.first.symlink?
    keg = versions.first
    receipt_path = keg/"INSTALL_RECEIPT.json"
    receipt = read_json(receipt_path)
    fail_contract("native receipt did not come from signed homebrew/core API") unless
      receipt["loaded_from_internal_api"] == true &&
      receipt["poured_from_bottle"] == true &&
      receipt.dig("source", "tap") == "homebrew/core"
    {
      "name" => rack.basename.to_s,
      "version" => keg.basename.to_s,
      "receipt_sha256" => Digest::SHA256.file(receipt_path).hexdigest,
    }
  end
end

mode = ARGV.shift
case mode
when "attest-source"
  fail_contract("usage: attest-source COMMIT REPOSITORY TREE OUT") unless
    ARGV.length == 4
  expected_commit, repository_path, tree_manifest, output = ARGV
  fail_contract("expected Homebrew commit is invalid") unless
    /\A[0-9a-f]{40}\z/.match?(expected_commit)
  repository = Pathname(repository_path)
  fail_contract("Homebrew repository is not a real directory") unless
    repository.absolute? && repository.directory? && !repository.symlink? &&
    repository.realpath == repository
  write_json(output, {
    "schema" => 1,
    "kind" => "kandelo-homebrew-native-source-attestation",
    "homebrew_commit" => expected_commit,
    "repository" => repository.to_s,
    "tracked_source" => tracked_source_inventory(
      repository, Pathname(tree_manifest)
    ),
    "ignored_runtime" => source_runtime_inventory(repository),
  })
when "prime"
  fail_contract("usage: prime COMMIT OUT") unless ARGV.length == 2
  expected_commit, output = ARGV
  check_brew_commit(expected_commit)
  prime_api
  source_provenance = api_source_provenance
  write_json(output, {
    "schema" => 1,
    "kind" => "kandelo-homebrew-native-api-prime",
    "architecture" => TARGET_TAG,
    "homebrew_commit" => expected_commit,
    "source" => source_provenance,
    "api_inventory" => api_inventory,
  })
when "recheck"
  fail_contract("usage: recheck COMMIT PRIME") unless ARGV.length == 2
  expected_commit, prime_path = ARGV
  check_brew_commit(expected_commit)
  prime = read_json(prime_path)
  check_api_seal
  fail_contract("Homebrew API cache changed after verification") unless
    prime["homebrew_commit"] == expected_commit &&
    prime["source"] == api_source_provenance &&
    prime["api_inventory"] == api_inventory
when "audit-cellar"
  fail_contract("usage: audit-cellar COMMIT PRIME ALLOWED REQUIRED OUT") unless ARGV.length == 5
  expected_commit, prime_path, allowed_path, required_path, output = ARGV
  check_brew_commit(expected_commit)
  prime = read_json(prime_path)
  allowed_names = read_names(allowed_path)
  required_names = read_names(required_path)
  fail_contract("requested Formula is outside the admitted closure") unless
    (required_names - allowed_names).empty?
  check_api_seal
  inventory = api_inventory
  fail_contract("Homebrew API cache changed after verification") unless
    prime["homebrew_commit"] == expected_commit &&
    prime["source"] == api_source_provenance &&
    prime["api_inventory"] == inventory
  write_json(output, {
    "schema" => 1,
    "kind" => "kandelo-homebrew-native-cellar-attestation",
    "homebrew_commit" => expected_commit,
    "allowed_closure" => allowed_names,
    "required_formulae" => required_names,
    "kegs" => audit_cellar(allowed_names, required_names),
    "api_inventory" => inventory,
  })
when "admit", "generate-lock"
  expected = mode == "admit" ? 8 : 6
  fail_contract("invalid #{mode} arguments") unless ARGV.length == expected
  expected_commit, policy_path = ARGV.shift(2)
  purpose = mode == "admit" ? ARGV.shift : "all"
  roots_path, closure_path, prime_path = ARGV.shift(3)
  lock_path = ARGV.shift if mode == "admit"
  output = ARGV.shift

  check_brew_commit(expected_commit)
  policy = read_json(policy_path)
  allowed_by_purpose = validate_policy(policy, expected_commit)
  roots = read_names(roots_path)
  closure = read_names(closure_path)
  fail_contract("native closure does not contain every direct root") unless (roots - closure).empty?
  if mode == "admit"
    allowed = allowed_by_purpose.fetch(purpose) { fail_contract("unknown native-root purpose: #{purpose}") }
    fail_contract("native plan contains a root outside its purpose") unless (roots - allowed).empty?
  else
    universe = allowed_by_purpose.values.flatten.sort.uniq
    fail_contract("lock generation must use the complete root universe") unless roots == universe
  end

  prime = read_json(prime_path)
  check_api_seal
  inventory = api_inventory
  fail_contract("Homebrew API cache changed after verification") unless
    prime["homebrew_commit"] == expected_commit &&
    prime["source"] == api_source_provenance &&
    prime["api_inventory"] == inventory
  records = selected_records(closure)

  if mode == "admit"
    lock = read_json(lock_path)
    expected_lock = {
      "schema" => 1,
      "kind" => "kandelo-homebrew-native-compatibility-lock",
      "architecture" => TARGET_TAG,
      "homebrew_commit" => expected_commit,
    }
    fail_contract("compatibility lock has unexpected fields") unless
      lock.keys.sort == (expected_lock.keys + ["formulae"]).sort
    expected_lock.each do |key, value|
      fail_contract("compatibility lock #{key} differs") unless lock[key] == value
    end
    locked_records = lock["formulae"]
    fail_contract("compatibility lock records are invalid") unless locked_records.is_a?(Hash)
    records.each do |name, record|
      fail_contract("signed API changed selected Formula #{name}") unless locked_records[name] == record
    end
    write_json(output, contract_envelope(
      expected_commit, purpose, roots, closure, records, inventory,
      prime.fetch("source")
    ))
  else
    write_json(output, {
      "schema" => 1,
      "kind" => "kandelo-homebrew-native-compatibility-lock",
      "architecture" => TARGET_TAG,
      "homebrew_commit" => expected_commit,
      "formulae" => records,
    })
  end
else
  fail_contract(
    "expected attest-source, prime, recheck, admit, generate-lock, or audit-cellar"
  )
end
