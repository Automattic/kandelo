# frozen_string_literal: true
#
# Roda todo application for the Kandelo browser demo.
#
# A real Ruby web app running on Kandelo: Roda (pure-Ruby routing) over the
# built-in sqlite3 gem, rendered with the standard-library ERB. This is NOT
# Rails; it is an honest example of the Ruby web stack that runs on the platform
# today. State lives in an SQLite database on the (ephemeral) VFS, so it is
# per-session by design.

require "rubygems"
$LOAD_PATH.unshift File.join(__dir__, "vendor")

require "roda"
require "sqlite3"
require "erb"

# The VFS is ephemeral in the browser, so the database is per-session by design.
# Default to the writable scratch mount; override with TODO_DB.
DB_PATH = ENV.fetch("TODO_DB", "/tmp/todo.sqlite3")
DB = SQLite3::Database.new(DB_PATH)
DB.busy_timeout = 2000
DB.execute(<<~SQL)
  CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  )
SQL

if DB.get_first_value("SELECT COUNT(*) FROM todos").to_i.zero?
  [
    "Try a real Ruby web app on Kandelo",
    "Add your own todo using the form",
    "Toggle a todo done — it persists for this session",
    "Delete one when you are finished",
  ].each { |t| DB.execute("INSERT INTO todos (title) VALUES (?)", [t]) }
end

VIEWS = File.join(__dir__, "views")

def render(name, locals = {})
  template = File.read(File.join(VIEWS, "#{name}.erb"))
  scope = binding
  locals.each { |k, v| scope.local_variable_set(k, v) }
  ERB.new(template, trim_mode: "-").result(scope)
end

def all_todos
  DB.execute("SELECT id, title, done, created_at FROM todos ORDER BY done, id")
end

def h(text)
  text.to_s.gsub("&", "&amp;").gsub("<", "&lt;").gsub(">", "&gt;").gsub('"', "&quot;")
end

class TodoApp < Roda
  route do |r|
    r.root do
      rows = all_todos
      remaining = rows.count { |_id, _t, done, _c| done.to_i.zero? }
      render("layout", body: render("index", todos: rows, remaining: remaining))
    end

    r.on "todos" do
      r.post true do
        title = r.params["title"].to_s.strip
        DB.execute("INSERT INTO todos (title) VALUES (?)", [title]) unless title.empty?
        r.redirect "/"
      end

      r.on Integer do |id|
        r.post "toggle" do
          DB.execute("UPDATE todos SET done = 1 - done WHERE id = ?", [id])
          r.redirect "/"
        end
        r.post "delete" do
          DB.execute("DELETE FROM todos WHERE id = ?", [id])
          r.redirect "/"
        end
      end
    end

    r.get "about" do
      render("layout", body: render("about",
        ruby: RUBY_VERSION,
        roda: Roda::RodaVersion,
        sqlite: SQLite3::SQLITE_VERSION))
    end
  end
end
