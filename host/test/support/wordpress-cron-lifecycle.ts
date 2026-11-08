import { verifyFrankenPhpGracefulShutdown } from "./frankenphp-graceful";

export const WORDPRESS_CRON_COUNTER = "/tmp/kandelo-wordpress-cron-count";
const publicOrigin = "http://public.example.test:9090";
const publicPath = "/computer/cron-test";
export const WORDPRESS_CRON_PUBLIC_URL = `${publicOrigin}${publicPath}/`;

interface CronHost {
  readFileFromVfs(path: string): Promise<Uint8Array | null>;
  writeFileToVfs(path: string, bytes: Uint8Array): Promise<void>;
  subscribeVfsChanges(prefix: string, callback: (event: { path: string }) => void): () => void;
  pickListenerTarget(port: number): Promise<{ pid: number; fd: number } | null>;
  spawnFromVfs(path: string, argv: string[]): Promise<{ pid: number; exit: Promise<number> }>;
  signalProcess(pid: number, signum: number): Promise<boolean>;
  fetchInKernel(port: number, request: {
    method: string; url: string; headers: Record<string, string>; body: null;
  }, options: { timeoutMs: number }): Promise<{ status: number; body: Uint8Array }>;
  subscribeSyscalls: Parameters<typeof verifyFrankenPhpGracefulShutdown>[0]["subscribeSyscalls"];
}

const decode = (bytes: Uint8Array | null) => new TextDecoder().decode(bytes ?? new Uint8Array());
function equal(actual: unknown, expected: unknown, stage: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${stage}: ${JSON.stringify({ actual, expected })}`);
  }
}

/** Install only test-owned observation files and ordinary runtime configuration. */
export async function prepareWordPressCronLifecycle(host: CronHost, port: number): Promise<void> {
  for (const target of ["nginx", "frankenphp-classic", "frankenphp-caddy"]) {
    if (!await host.readFileFromVfs(`/etc/dinit.d/${target}-cron`)) {
      throw new Error(`Image has no ${target} cron service; rebuild WordPress`);
    }
  }
  if (!await host.readFileFromVfs("/etc/dinit.d/wordpress-cron-config")) {
    throw new Error("Image has no WordPress public URL configuration service; rebuild WordPress");
  }
  const write = (path: string, text: string) => host.writeFileToVfs(path, new TextEncoder().encode(text));
  const template = await host.readFileFromVfs("/etc/wp-config-template.php");
  if (!template) throw new Error("WordPress runtime config template is missing");
  await write("/srv/www/html/wp-config.php", decode(template).replaceAll("@@APP_PATH@@", "/").replaceAll("@@PROTO@@", "http"));
  const cronConfig = await host.readFileFromVfs("/etc/wordpress/cron.curl");
  if (!cronConfig) throw new Error("WordPress cron client configuration is missing");
  await write("/etc/wordpress/cron.curl", decode(cronConfig).replace(":8080/wp-cron.php", `:${port}/wp-cron.php`));
  await write(WORDPRESS_CRON_COUNTER, "0");
  // Caddy and FPM use different credentials. This one disposable test counter
  // must permit both; it is not installed in the shipped image.
  const chmod = await host.spawnFromVfs("/bin/chmod", ["chmod", "666", WORDPRESS_CRON_COUNTER]);
  equal(await chmod.exit, 0, "counter permissions");
  await write("/srv/www/html/wp-content/mu-plugins/kandelo-cron-lifecycle.php", `<?php
add_action('kandelo_cron_lifecycle_test', static function () {
    $path = '${WORDPRESS_CRON_COUNTER}';
    $count = (int) file_get_contents($path) + 1;
    file_put_contents($path, $count . ':' . home_url());
});
`);
  await write("/srv/www/html/__kandelo_cron_lifecycle.php", `<?php
require __DIR__ . '/wp-load.php';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    wp_clear_scheduled_hook('kandelo_cron_lifecycle_test');
    if (!wp_schedule_single_event(time() - 1, 'kandelo_cron_lifecycle_test')) {
        throw new RuntimeException('Could not schedule the lifecycle test event');
    }
}
header('Content-Type: application/json');
echo json_encode(array('scheduled' => wp_next_scheduled('kandelo_cron_lifecycle_test')));
`);
}

export interface WordPressCronObservation {
  stage: string;
  at: string;
  count?: string;
  graceful?: unknown;
}

/** Exercise real wp-cron and Dinit across all three image-owned alternatives. */
export async function verifyWordPressCronLifecycle(
  host: CronHost,
  port: number,
  waitForExit: (pid: number) => Promise<number>,
  record: (row: WordPressCronObservation) => Promise<void> = async () => {},
): Promise<WordPressCronObservation[]> {
  const observations: WordPressCronObservation[] = [];
  const read = async (path: string) => decode(await host.readFileFromVfs(path));
  const observe = async (stage: string) => {
    const row = { stage, at: new Date().toISOString(), count: await read(WORDPRESS_CRON_COUNTER) };
    observations.push(row);
    await record(row);
  };
  const waitCount = async (wanted: number) => {
    await new Promise<void>((resolve, reject) => {
      let complete = false;
      const finish = (error?: unknown) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error); else resolve();
      };
      const check = () => { void read(WORDPRESS_CRON_COUNTER).then(value => {
        if (Number(value.split(":")[0]) >= wanted) finish();
      }, finish); };
      const unsubscribe = host.subscribeVfsChanges(WORDPRESS_CRON_COUNTER, check);
      const timer = setTimeout(() => finish(new Error(`WordPress cron count ${wanted} timed out`)), 95_000);
      check();
    });
    equal(await read(WORDPRESS_CRON_COUNTER), `${wanted}:${publicOrigin}${publicPath}`, "cron action and public URL");
  };
  const command = async (action: string, target: string) => {
    const process = await host.spawnFromVfs("/usr/bin/kandelo-service", ["kandelo-service", action, target]);
    equal(await process.exit, 0, `${action} ${target}`);
  };
  const schedule = async () => {
    const response = await host.fetchInKernel(port, {
      method: "POST", url: "/__kandelo_cron_lifecycle.php", headers: { Host: `localhost:${port}` }, body: null,
    }, { timeoutMs: 30_000 });
    equal(response.status, 200, "schedule event response");
    equal(typeof JSON.parse(decode(response.body)).scheduled, "number", "scheduled WordPress event");
  };

  await schedule(); await waitCount(1); await observe("automatic WordPress cron action");
  await schedule(); await command("stop", "frankenphp-caddy");
  equal(await host.pickListenerTarget(port), null, "server exit before completed activity stop");
  const caddyStopped = await read("/var/log/frankenphp-caddy-cron.log");
  // Cross a complete real minute. Do not age files or replace WordPress time.
  await new Promise(resolve => setTimeout(resolve, 65_000));
  equal(await read(WORDPRESS_CRON_COUNTER), `1:${publicOrigin}${publicPath}`, "stopped cron action count");
  equal(await read("/var/log/frankenphp-caddy-cron.log"), caddyStopped, "stopped scheduler log");
  await observe("stopped for a full scheduling interval");
  await command("start", "frankenphp-caddy"); await waitCount(2); await observe("restart resumes pending cron");
  await schedule();
  const previous = await host.pickListenerTarget(port);
  if (!previous) throw new Error("Caddy listener missing before crash");
  equal(await host.signalProcess(previous.pid, 9), true, "SIGKILL delivery");
  await waitCount(3);
  const recovered = await host.pickListenerTarget(port);
  if (!recovered || recovered.pid === previous.pid) throw new Error("Caddy did not replace its crashed listener");
  await observe("Caddy crash recovery resumes cron");
  await schedule(); await command("start", "nginx"); await waitCount(4); await observe("FPM owns pending cron");
  const caddyAfterSwitch = await read("/var/log/frankenphp-caddy-cron.log");
  await new Promise(resolve => setTimeout(resolve, 65_000));
  equal(await read("/var/log/frankenphp-caddy-cron.log"), caddyAfterSwitch, "Caddy scheduler after FPM switch");
  if ((await read("/var/log/nginx-cron.log")).split("CRON_HTTP:200").length < 3) {
    throw new Error("FPM scheduler did not complete two successful minute requests");
  }
  await observe("FPM owns the next minute without Caddy cron");
  await schedule(); await command("start", "frankenphp-classic"); await waitCount(5); await observe("classic owns pending cron");
  const graceful = await verifyFrankenPhpGracefulShutdown(host, port, waitForExit, "frankenphp-classic");
  equal(await host.pickListenerTarget(port), null, "classic listener after held-PHP drain");
  const row = { stage: "held PHP drained through activity stop", at: new Date().toISOString(), graceful };
  observations.push(row); await record(row);
  return observations;
}
