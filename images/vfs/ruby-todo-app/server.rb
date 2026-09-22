# frozen_string_literal: true
#
# Minimal single-threaded Rack HTTP/1.1 server over the standard-library socket.
#
# Kandelo's Ruby build statically links a curated set of extensions; WEBrick's
# dependencies (io/nonblock, fiber, openssl) are not among them, so this demo
# serves the Rack app with a small, self-contained loop over TCPServer (which is
# supported on the platform). It handles GET and urlencoded POST with
# Connection: close — enough for the todo app behind the browser HTTP bridge.

require "socket"
require "stringio"
require_relative "app"

HOST = ENV.fetch("TODO_HOST", "0.0.0.0")
PORT = Integer(ENV.fetch("TODO_PORT", "8080"))

STATUS_TEXT = {
  200 => "OK", 302 => "Found", 303 => "See Other",
  400 => "Bad Request", 404 => "Not Found", 500 => "Internal Server Error"
}.freeze

def build_env(method, path, headers, body)
  uri, query = path.split("?", 2)
  host = headers["host"] || "localhost:#{PORT}"
  env = {
    "REQUEST_METHOD" => method,
    "SCRIPT_NAME" => "",
    "PATH_INFO" => uri,
    "REQUEST_PATH" => uri,
    "QUERY_STRING" => query || "",
    "SERVER_NAME" => host.split(":").first,
    "SERVER_PORT" => (host.split(":")[1] || PORT.to_s),
    "SERVER_PROTOCOL" => "HTTP/1.1",
    "HTTP_HOST" => host,
    "CONTENT_LENGTH" => (headers["content-length"] || "0"),
    "CONTENT_TYPE" => headers["content-type"] || "application/octet-stream",
    "rack.input" => StringIO.new(body),
    "rack.errors" => $stderr,
    "rack.url_scheme" => "http",
  }
  headers.each do |k, v|
    key = "HTTP_#{k.upcase.tr('-', '_')}"
    env[key] ||= v
  end
  env
end

def handle(conn)
  request_line = conn.gets
  return unless request_line

  method, path, = request_line.split(" ", 3)
  return if method.nil? || path.nil?

  headers = {}
  while (line = conn.gets)
    break if line == "\r\n" || line == "\n"
    key, value = line.chomp.split(":", 2)
    headers[key.strip.downcase] = value&.strip if key
  end

  body = ""
  if (len = headers["content-length"]) && len.to_i.positive?
    body = conn.read(len.to_i) || ""
  end

  env = build_env(method, path, headers, body)
  status, resp_headers, resp_body = TodoApp.call(env)

  payload = +""
  resp_body.each { |chunk| payload << chunk }
  resp_body.close if resp_body.respond_to?(:close)

  out = +"HTTP/1.1 #{status} #{STATUS_TEXT[status.to_i] || 'OK'}\r\n"
  resp_headers.each do |k, v|
    Array(v).each { |vv| out << "#{k}: #{vv}\r\n" }
  end
  out << "Content-Length: #{payload.bytesize}\r\n"
  out << "Connection: close\r\n\r\n"
  conn.write(out)
  conn.write(payload)
end

server = TCPServer.new(HOST, PORT)
$stdout.sync = true
puts "ruby-todo listening on #{HOST}:#{PORT} (Ruby #{RUBY_VERSION}, Roda #{Roda::RodaVersion}, SQLite #{SQLite3::SQLITE_VERSION})"

loop do
  conn = nil
  begin
    conn = server.accept
    handle(conn)
  rescue => e
    warn "request error: #{e.class}: #{e.message}"
  ensure
    begin
      conn&.close
    rescue StandardError
      nil
    end
  end
end
