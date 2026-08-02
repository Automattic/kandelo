#!/usr/bin/env ruby
# frozen_string_literal: true

# Bound and render diagnostics from the credential-free native Homebrew realm.

MAX_CAPTURE_BYTES = 16 * 1024
MAX_CAPTURE_FILE_BYTES = MAX_CAPTURE_BYTES + 64
MAX_RENDERED_LINES = 200

def fail_diagnostic(message)
  warn "homebrew-native-command-diagnostic: #{message}"
  exit 2
end

def private_regular_file(path, flags)
  fail_diagnostic("safe no-follow file access is unavailable") unless
    File.const_defined?(:NOFOLLOW)

  file = File.open(path, flags | File::NOFOLLOW)
  stat = file.stat
  unless stat.file? && stat.uid == Process.uid && stat.nlink == 1 &&
         (stat.mode & 0o077).zero?
    file.close
    fail_diagnostic("diagnostic log is not a private regular file")
  end
  file
rescue SystemCallError, IOError
  fail_diagnostic("diagnostic log is not a private regular file")
end

def create_private_regular_file(path)
  fail_diagnostic("safe no-follow file access is unavailable") unless
    File.const_defined?(:NOFOLLOW)

  file = File.open(
    path,
    File::WRONLY | File::CREAT | File::EXCL | File::NOFOLLOW,
    0o600
  )
  stat = file.stat
  unless stat.file? && stat.uid == Process.uid && stat.nlink == 1 &&
         (stat.mode & 0o077).zero?
    file.close
    fail_diagnostic("diagnostic log is not a private regular file")
  end
  file
rescue SystemCallError, IOError
  fail_diagnostic("diagnostic log is not a private regular file")
end

def capture(path)
  destination = create_private_regular_file(path)
  buffer = +"".b
  total = 0
  while (chunk = STDIN.read(8192))
    total += chunk.bytesize
    buffer << chunk
    buffer = buffer.byteslice(-MAX_CAPTURE_BYTES, MAX_CAPTURE_BYTES) if
      buffer.bytesize > MAX_CAPTURE_BYTES
  end
  if total > MAX_CAPTURE_BYTES
    destination.write("[... earlier native Homebrew output omitted ...]\n")
  end
  destination.write(buffer)
rescue SystemExit => error
  # WHY: even an unsafe destination must not close the pipe early. Draining
  # prevents a diagnostic failure from replacing the native command's status
  # with SIGPIPE while the caller reports that diagnostics were unavailable.
  nil while STDIN.read(8192)
  raise error
ensure
  destination&.close
end

def append(source_path, destination_path)
  source = private_regular_file(source_path, File::RDONLY)
  fail_diagnostic("bounded diagnostic log is unexpectedly large") if
    source.stat.size > MAX_CAPTURE_FILE_BYTES
  destination = private_regular_file(
    destination_path,
    File::WRONLY | File::APPEND
  )
  IO.copy_stream(source, destination)
ensure
  source&.close
  destination&.close
end

def escaped_and_redacted(bytes)
  escaped = bytes.each_byte.map do |byte|
    case byte
    when 0x0a
      "\n"
    when 0x20..0x7e
      byte.chr
    else
      format("\\x%02X", byte)
    end
  end.join

  # These commands receive no publisher credentials. Redaction is still
  # defense in depth in case an upstream diagnostic repeats authentication
  # material embedded in a URL or supplied by an unexpected host wrapper.
  escaped
    .gsub(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
          "[redacted-github-token]")
    .gsub(%r{(https?://)[^/\s:@]+:[^/\s@]+@}i, '\\1[redacted]@')
    .gsub(/([?&](?:access_token|token|password|secret)=)[^&\s]+/i,
          '\\1[redacted]')
    .gsub(/(Authorization:\s*)(?:Basic|Bearer)\s+\S+/i,
          '\\1[redacted]')
end

def render(path)
  file = private_regular_file(path, File::RDONLY)
  fail_diagnostic("bounded diagnostic log is unexpectedly large") if
    file.stat.size > MAX_CAPTURE_FILE_BYTES
  rendered = escaped_and_redacted(file.read)
  lines = rendered.split("\n", -1)
  lines.pop if lines.last == ""
  if lines.length > MAX_RENDERED_LINES
    lines = lines.last(MAX_RENDERED_LINES - 1)
    puts "| [... earlier diagnostic lines omitted ...]"
  end
  if lines.empty?
    puts "| (the command produced no diagnostic output)"
  else
    lines.each { |line| puts "| #{line}" }
  end
ensure
  file&.close
end

command = ARGV.shift
case command
when "capture"
  fail_diagnostic("capture expects PATH") unless ARGV.length == 1
  capture(ARGV.fetch(0))
when "append"
  fail_diagnostic("append expects SOURCE DESTINATION") unless ARGV.length == 2
  append(*ARGV)
when "render"
  fail_diagnostic("render expects PATH") unless ARGV.length == 1
  render(ARGV.fetch(0))
else
  fail_diagnostic("expected capture, append, or render")
end
