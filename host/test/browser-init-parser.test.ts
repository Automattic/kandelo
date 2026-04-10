import { describe, it, expect } from "vitest";
import { parseServiceDescriptor } from "../../examples/browser/lib/init/service-descriptor";

describe("parseServiceDescriptor", () => {
  describe("filename parsing", () => {
    it("extracts order and name from NN-name format", () => {
      const desc = parseServiceDescriptor(
        "20-nginx",
        "type=daemon\ncommand=/usr/sbin/nginx",
      );
      expect(desc.order).toBe(20);
      expect(desc.name).toBe("nginx");
    });

    it("uses order=50 when no numeric prefix", () => {
      const desc = parseServiceDescriptor(
        "myservice",
        "type=daemon\ncommand=/usr/bin/myservice",
      );
      expect(desc.order).toBe(50);
      expect(desc.name).toBe("myservice");
    });

    it("handles multi-digit order prefix", () => {
      const desc = parseServiceDescriptor(
        "05-early",
        "type=oneshot\ncommand=/bin/setup",
      );
      expect(desc.order).toBe(5);
      expect(desc.name).toBe("early");
    });

    it("handles name with hyphens after prefix", () => {
      const desc = parseServiceDescriptor(
        "30-php-fpm",
        "type=daemon\ncommand=/usr/sbin/php-fpm",
      );
      expect(desc.order).toBe(30);
      expect(desc.name).toBe("php-fpm");
    });
  });

  describe("daemon service with port readiness and bridge", () => {
    const content = `
# Nginx web server
type=daemon
command=/usr/sbin/nginx -c "/etc/nginx/nginx.conf"
ready=port:8080
bridge=8080
cwd=/var/www
`;

    it("parses all fields correctly", () => {
      const desc = parseServiceDescriptor("20-nginx", content);
      expect(desc).toEqual({
        name: "nginx",
        order: 20,
        type: "daemon",
        command: ["/usr/sbin/nginx", "-c", "/etc/nginx/nginx.conf"],
        ready: { kind: "port", port: 8080 },
        bridge: 8080,
        cwd: "/var/www",
      });
    });
  });

  describe("interactive service with env and pty", () => {
    const content = `
type=interactive
command=/bin/dash
env=HOME=/root TERM=xterm-256color PATH=/usr/bin:/bin
pty=true
`;

    it("parses env as space-separated KEY=VALUE pairs", () => {
      const desc = parseServiceDescriptor("90-shell", content);
      expect(desc.type).toBe("interactive");
      expect(desc.command).toEqual(["/bin/dash"]);
      expect(desc.env).toEqual([
        "HOME=/root",
        "TERM=xterm-256color",
        "PATH=/usr/bin:/bin",
      ]);
      expect(desc.pty).toBe(true);
      expect(desc.order).toBe(90);
      expect(desc.name).toBe("shell");
    });
  });

  describe("oneshot with stdin, depends, and terminate", () => {
    const content = `
type=oneshot
command=/usr/sbin/mariadbd --bootstrap
stdin=/etc/mysql/bootstrap.sql
depends=filesystem
terminate=true
`;

    it("parses oneshot fields", () => {
      const desc = parseServiceDescriptor("15-mariadb-bootstrap", content);
      expect(desc.type).toBe("oneshot");
      expect(desc.command).toEqual(["/usr/sbin/mariadbd", "--bootstrap"]);
      expect(desc.stdin).toBe("/etc/mysql/bootstrap.sql");
      expect(desc.depends).toEqual(["filesystem"]);
      expect(desc.terminate).toBe(true);
      expect(desc.name).toBe("mariadb-bootstrap");
      expect(desc.order).toBe(15);
    });
  });

  describe("delay readiness", () => {
    it("parses delay:N format", () => {
      const desc = parseServiceDescriptor(
        "50-slow",
        "type=daemon\ncommand=/usr/bin/slow\nready=delay:2000",
      );
      expect(desc.ready).toEqual({ kind: "delay", ms: 2000 });
    });
  });

  describe("exit readiness", () => {
    it("parses exit ready condition", () => {
      const desc = parseServiceDescriptor(
        "10-setup",
        "type=oneshot\ncommand=/bin/setup\nready=exit",
      );
      expect(desc.ready).toEqual({ kind: "exit" });
    });
  });

  describe("stdin-consumed readiness", () => {
    it("parses stdin-consumed ready condition", () => {
      const desc = parseServiceDescriptor(
        "10-bootstrap",
        "type=oneshot\ncommand=/usr/bin/db --bootstrap\nready=stdin-consumed\nstdin=/etc/db/init.sql",
      );
      expect(desc.ready).toEqual({ kind: "stdin-consumed" });
      expect(desc.stdin).toBe("/etc/db/init.sql");
    });
  });

  describe("comments and blank lines", () => {
    const content = `
# This is a comment
type=daemon

# Another comment
command=/usr/bin/server

# Blank lines above and below are fine

ready=port:3000
`;

    it("skips comments and blank lines", () => {
      const desc = parseServiceDescriptor("40-server", content);
      expect(desc.type).toBe("daemon");
      expect(desc.command).toEqual(["/usr/bin/server"]);
      expect(desc.ready).toEqual({ kind: "port", port: 3000 });
    });
  });

  describe("depends parsing", () => {
    it("parses comma-separated dependencies", () => {
      const desc = parseServiceDescriptor(
        "50-app",
        "type=daemon\ncommand=/bin/app\ndepends=nginx,php-fpm,mariadb",
      );
      expect(desc.depends).toEqual(["nginx", "php-fpm", "mariadb"]);
    });

    it("handles spaces around commas in depends", () => {
      const desc = parseServiceDescriptor(
        "50-app",
        "type=daemon\ncommand=/bin/app\ndepends=nginx, php-fpm , mariadb",
      );
      expect(desc.depends).toEqual(["nginx", "php-fpm", "mariadb"]);
    });

    it("treats depends=none as no dependencies", () => {
      const desc = parseServiceDescriptor(
        "50-app",
        "type=daemon\ncommand=/bin/app\ndepends=none",
      );
      expect(desc.depends).toBeUndefined();
    });
  });

  describe("command splitting", () => {
    it("handles simple command", () => {
      const desc = parseServiceDescriptor(
        "50-test",
        "type=daemon\ncommand=/bin/test",
      );
      expect(desc.command).toEqual(["/bin/test"]);
    });

    it("handles command with multiple args", () => {
      const desc = parseServiceDescriptor(
        "50-test",
        "type=daemon\ncommand=/bin/test -a -b -c",
      );
      expect(desc.command).toEqual(["/bin/test", "-a", "-b", "-c"]);
    });

    it("handles double-quoted segments with spaces", () => {
      const desc = parseServiceDescriptor(
        "50-test",
        'type=daemon\ncommand=/bin/test --config "/path with spaces/config.conf" --verbose',
      );
      expect(desc.command).toEqual([
        "/bin/test",
        "--config",
        "/path with spaces/config.conf",
        "--verbose",
      ]);
    });
  });

  describe("defaults", () => {
    it("defaults type to daemon", () => {
      const desc = parseServiceDescriptor(
        "50-minimal",
        "command=/bin/minimal",
      );
      expect(desc.type).toBe("daemon");
    });

    it("optional fields are absent when not specified", () => {
      const desc = parseServiceDescriptor(
        "50-minimal",
        "command=/bin/minimal",
      );
      expect(desc.env).toBeUndefined();
      expect(desc.cwd).toBeUndefined();
      expect(desc.ready).toBeUndefined();
      expect(desc.depends).toBeUndefined();
      expect(desc.bridge).toBeUndefined();
      expect(desc.pty).toBeUndefined();
      expect(desc.stdin).toBeUndefined();
      expect(desc.terminate).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("throws on missing command", () => {
      expect(() =>
        parseServiceDescriptor("50-bad", "type=daemon"),
      ).toThrow('missing a command field');
    });

    it("throws on unknown service type", () => {
      expect(() =>
        parseServiceDescriptor(
          "50-bad",
          "type=bogus\ncommand=/bin/test",
        ),
      ).toThrow("Unknown service type: bogus");
    });

    it("throws on unknown ready condition", () => {
      expect(() =>
        parseServiceDescriptor(
          "50-bad",
          "type=daemon\ncommand=/bin/test\nready=bogus",
        ),
      ).toThrow("Unknown ready condition: bogus");
    });
  });

  describe("pty=false", () => {
    it("sets pty to false when value is not 'true'", () => {
      const desc = parseServiceDescriptor(
        "50-test",
        "type=daemon\ncommand=/bin/test\npty=false",
      );
      expect(desc.pty).toBe(false);
    });
  });

  describe("terminate=false", () => {
    it("sets terminate to false when value is not 'true'", () => {
      const desc = parseServiceDescriptor(
        "50-test",
        "type=daemon\ncommand=/bin/test\nterminate=false",
      );
      expect(desc.terminate).toBe(false);
    });
  });
});
