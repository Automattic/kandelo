import {
  formatMysqlEvidenceResult,
  formatRedisEvidenceResult,
  protectedNodeSuiteDefinition,
  validateProtectedNodeSuiteStep,
  type NodeRepositorySuite,
} from "./abi-staging-product-node-evidence.ts";
import type { MySqlResult } from "../apps/browser-demos/lib/mysql-client.ts";
import type { RedisResult } from "../apps/browser-demos/lib/redis-client.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_ITEMS = 64;

export interface ProtectedBrowserProcessObservation {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProtectedBrowserOperationAdapter {
  startService(): Promise<void>;
  exec(request: {
    argv: string[];
    env?: Record<string, string>;
    stdin?: string;
  }): Promise<ProtectedBrowserProcessObservation>;
  pty(input: string): Promise<ProtectedBrowserProcessObservation>;
  fetchHttp(path: string): Promise<{ status: number; body: string }>;
  verifyWordPressLogin(): Promise<{
    adminBody: string;
    adminStatus: number;
    authenticatedCookie: boolean;
    loginBody: string;
    loginStatus: number;
    redirectLocation: string;
    redirectStatus: number;
  }>;
  queryMySql(statement: string): Promise<MySqlResult>;
  queryRedis(request: string): Promise<RedisResult>;
  observeFramebuffer(request: {
    programPath: string;
    argv: string[];
  }): Promise<{ nonzeroPixels: number }>;
  observeModeset(request: {
    programPath: string;
    argv: string[];
    width: number;
    height: number;
  }): Promise<{
    commitCount: number;
    nonzeroPixels: number;
    width: number;
    height: number;
  }>;
}

export interface ProtectedBrowserOperationDefinition {
  id: string;
  runner: string;
  probe: Readonly<Record<string, unknown>>;
}

export async function executeProtectedBrowserOperation(
  definition: ProtectedBrowserOperationDefinition,
  surface: string,
  adapter: ProtectedBrowserOperationAdapter,
): Promise<string> {
  switch (definition.runner) {
    case "exec": {
      const observation = await adapter.exec({
        argv: stringArray(definition.probe.argv, "exec argv"),
        ...(definition.probe.env === undefined
          ? {}
          : { env: stringRecord(definition.probe.env, "exec environment") }),
        ...(definition.probe.stdin === undefined
          ? {}
          : { stdin: text(definition.probe.stdin, "exec stdin", MAX_OUTPUT_BYTES) }),
      });
      const expectedStatus = definition.probe.expected_status === undefined
        ? 0
        : integer(definition.probe.expected_status, "exec status");
      if (observation.exitCode !== expectedStatus) {
        throw new Error("protected browser exec returned the wrong status");
      }
      assertPredicate(observation.stdout, stringPredicate(definition.probe, "stdout"));
      return boundedOutput(observation.stdout);
    }
    case "interactive-terminal": {
      const input = stringArray(definition.probe.input, "terminal input");
      const expected = stringArray(
        definition.probe.output_contains,
        "terminal output predicate",
      );
      if (input.length !== expected.length) {
        throw new Error("protected terminal input and output predicates differ");
      }
      let output = "";
      for (const [index, command] of input.entries()) {
        const observation = await adapter.pty(command);
        if (observation.exitCode !== 0) {
          throw new Error("protected browser PTY returned the wrong status");
        }
        if (!observation.stdout.includes(expected[index]!)) {
          throw new Error("protected browser PTY output predicate failed");
        }
        output = boundedOutput(output + observation.stdout);
      }
      return output;
    }
    case "http":
      return executeHttpProbe(definition.probe, adapter);
    case "sql": {
      const statements = stringArray(definition.probe.statements, "SQL statements");
      const expected = stringArray(definition.probe.results_exact, "SQL results");
      if (statements.length !== expected.length) {
        throw new Error("protected SQL statements and results differ");
      }
      const observed: string[] = [];
      for (const [index, statement] of statements.entries()) {
        const result = await adapter.queryMySql(statement);
        const value = formatMysqlEvidenceResult(result);
        if (value !== expected[index]) {
          throw new Error("protected SQL result predicate failed");
        }
        observed.push(value);
      }
      return boundedOutput(`${observed.join("\n")}\n`);
    }
    case "service-protocol": {
      if (definition.probe.protocol !== "redis") {
        throw new Error("protected browser service protocol is unsupported");
      }
      const request = text(definition.probe.request, "Redis request", 4_096);
      const expected = text(
        definition.probe.response_exact,
        "Redis response",
        MAX_OUTPUT_BYTES,
      );
      const result = await adapter.queryRedis(request);
      const observed = formatRedisEvidenceResult(result);
      if (observed !== expected) {
        throw new Error("protected Redis response predicate failed");
      }
      return boundedOutput(`${observed}\n`);
    }
    case "repository-suite":
      return executeRepositorySuite(definition.probe, surface, adapter);
    default:
      throw new Error(`protected browser runner is unsupported: ${definition.runner}`);
  }
}

async function executeHttpProbe(
  probe: Readonly<Record<string, unknown>>,
  adapter: ProtectedBrowserOperationAdapter,
): Promise<string> {
  const path = absolutePath(probe.path);
  const expectedStatus = integer(probe.status, "HTTP status");
  const result = await adapter.fetchHttp(path);
  if (result.status !== expectedStatus) {
    throw new Error("protected browser HTTP status predicate failed");
  }
  assertPredicate(result.body, stringPredicate(probe, "body"));
  return boundedOutput(`http-${result.status}:${path}\n${result.body}`);
}

async function executeRepositorySuite(
  probe: Readonly<Record<string, unknown>>,
  surface: string,
  adapter: ProtectedBrowserOperationAdapter,
): Promise<string> {
  const suite = text(probe.suite, "browser repository suite", 128);
  if (
    (surface === "wordpress-sqlite" && suite === "wordpress-sqlite-browser") ||
    (surface === "wordpress-mariadb" && suite === "wordpress-mariadb-browser")
  ) {
    const observation = await adapter.verifyWordPressLogin();
    if (
      observation.loginStatus !== 200 ||
      !observation.loginBody.includes("loginform") ||
      observation.redirectStatus !== 302 ||
      !observation.redirectLocation.startsWith("/wp-admin/") ||
      !observation.authenticatedCookie ||
      observation.adminStatus !== 200 ||
      !/(?:id=["'](?:wpadminbar|adminmenu)["']|class=["'][^"']*wp-admin)/u.test(
        observation.adminBody,
      )
    ) {
      throw new Error("protected WordPress login predicate failed");
    }
    return "wordpress-authenticated-admin-ready\n";
  }
  if (surface === "doom" && suite === "main-shell-fbdoom-browser") {
    const observation = await adapter.observeFramebuffer({
      programPath: "/usr/local/bin/fbdoom",
      argv: ["/usr/local/bin/fbdoom", "-iwad", "/doom1.wad"],
    });
    if (!Number.isSafeInteger(observation.nonzeroPixels) || observation.nonzeroPixels < 1) {
      throw new Error("protected fbDOOM framebuffer remained empty");
    }
    return `fbdoom-nonzero-pixels:${observation.nonzeroPixels}\n`;
  }
  if (surface === "modeset" && suite === "main-shell-modeset-browser") {
    const observation = await adapter.observeModeset({
      programPath: "/usr/local/bin/modeset",
      argv: ["/usr/local/bin/modeset"],
      width: 1920,
      height: 1080,
    });
    if (
      !Number.isSafeInteger(observation.commitCount) || observation.commitCount < 1 ||
      !Number.isSafeInteger(observation.nonzeroPixels) ||
      observation.nonzeroPixels < 1 ||
      observation.width !== 1920 || observation.height !== 1080
    ) {
      if (observation.nonzeroPixels < 1) {
        throw new Error("protected modeset scanout rendered no visible pixels");
      }
      throw new Error("protected modeset observation lacks a committed scanout");
    }
    return `modeset:${observation.commitCount}:${observation.width}x` +
      `${observation.height}:pixels=${observation.nonzeroPixels}\n`;
  }
  const nodeSuiteByBrowserSuite: Readonly<Record<string, NodeRepositorySuite>> = {
    "mariadb-product-browser": "mariadb-product-node",
    "php-product-browser": "php-product-node",
    "sqlite-product-browser": "sqlite-product-node",
  };
  const nodeSuite = nodeSuiteByBrowserSuite[suite];
  if (nodeSuite === undefined) {
    throw new Error("protected browser repository suite is unsupported");
  }
  const definition = protectedNodeSuiteDefinition(nodeSuite);
  if (definition.service !== undefined) await adapter.startService();
  let output = "";
  for (const step of definition.steps) {
    const observation = await adapter.exec({
      argv: [...step.argv],
      ...(step.env === undefined ? {} : { env: { ...step.env } }),
    });
    validateProtectedNodeSuiteStep(step, {
      status: observation.exitCode,
      stdout: observation.stdout,
      stderr: observation.stderr,
    });
    output = boundedOutput(`${output}${step.id}:pass\n`);
  }
  return output;
}

function stringPredicate(
  probe: Readonly<Record<string, unknown>>,
  prefix: "stdout" | "body",
): { kind: "exact" | "contains" | "regex"; value: string } {
  for (const kind of ["exact", "contains", "regex"] as const) {
    const value = probe[`${prefix}_${kind}`];
    if (value !== undefined) {
      return { kind, value: text(value, `${prefix} predicate`, MAX_OUTPUT_BYTES) };
    }
  }
  throw new Error(`protected ${prefix} predicate is absent`);
}

function assertPredicate(
  actual: string,
  predicate: { kind: "exact" | "contains" | "regex"; value: string },
): void {
  if (
    (predicate.kind === "exact" && actual !== predicate.value) ||
    (predicate.kind === "contains" && !actual.includes(predicate.value)) ||
    (predicate.kind === "regex" && !new RegExp(predicate.value, "u").test(actual))
  ) {
    throw new Error(`protected ${predicate.kind} predicate failed`);
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ITEMS) {
    throw new Error(`${label} is outside its bound`);
  }
  return value.map((item, index) => text(item, `${label} ${index}`, MAX_OUTPUT_BYTES));
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ITEMS) throw new Error(`${label} is outside its bound`);
  const output: Record<string, string> = {};
  for (const [name, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`${label} name is invalid`);
    }
    output[name] = text(item, `${label} value`, MAX_OUTPUT_BYTES);
  }
  return output;
}

function absolutePath(value: unknown): string {
  const path = text(value, "HTTP path", 4_096);
  if (
    !path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("protected HTTP path is invalid");
  }
  return path;
}

function text(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new Error(`${label} exceeds its byte bound`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is invalid`);
  return value as number;
}

function boundedOutput(value: string): string {
  if (new TextEncoder().encode(value).byteLength > MAX_OUTPUT_BYTES) {
    throw new Error("protected browser operation output exceeded its byte bound");
  }
  return value;
}
