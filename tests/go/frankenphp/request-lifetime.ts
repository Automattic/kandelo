/** Shared Node/browser proof for upstream FrankenPHP's bulk CGI strings. */
export const requestLifetimePhp = `<?php
header('Content-Type: application/json');
echo json_encode([
    'method' => $_SERVER['REQUEST_METHOD'],
    'uri' => $_SERVER['REQUEST_URI'],
    'query' => $_SERVER['QUERY_STRING'],
    'script' => $_SERVER['SCRIPT_NAME'],
    'filename' => $_SERVER['SCRIPT_FILENAME'],
    'software' => $_SERVER['SERVER_SOFTWARE'],
    'host' => $_SERVER['HTTP_HOST'],
    'token' => $_SERVER['HTTP_X_LIFETIME_TOKEN'],
    'body' => file_get_contents('php://input'),
], JSON_THROW_ON_ERROR);
`;

export function countGoCollections(stderr: string): number {
  return [...stderr.matchAll(/\bgc \d+ @/g)].length;
}

export async function verifyRequestStringLifetimes(host: {
  fetchInKernel(port: number, request: {
    method: string; url: string; headers: Record<string, string>; body: Uint8Array;
  }, options: { timeoutMs: number }): Promise<{ status: number; body: Uint8Array }>;
}, port = 8080) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // Repeated concurrent requests exercise Go-owned strings while PHP workers
  // consume them. The caller must also observe collection during this phase.
  for (let batch = 0; batch < 8; batch++) {
    await Promise.all([0, 1, 2, 3].map(async (index) => {
      const round = batch * 4 + index;
      const token = `round-${round}-` + "x".repeat(256);
      const query = `token=${round}&payload=` + "q".repeat(8192);
      const uri = "/lifetime.php?" + query;
      const body = `body-${round}-` + "b".repeat(8192);
      const response = await host.fetchInKernel(port, {
        method: "POST", url: uri,
        headers: {
          Host: `localhost:${port}`, "Content-Type": "text/plain",
          "X-Lifetime-Token": token,
        },
        body: encoder.encode(body),
      }, { timeoutMs: 30_000 });
      if (response.status !== 200) {
        throw new Error(`CGI lifetime request ${round}: HTTP ${response.status}`);
      }
      const actual = JSON.parse(decoder.decode(response.body)) as Record<string, unknown>;
      const expected = {
        method: "POST", uri, query, script: "/lifetime.php",
        filename: "/srv/www/html/lifetime.php", software: "FrankenPHP",
        host: `localhost:${port}`, token, body,
      };
      if (Object.keys(actual).length !== Object.keys(expected).length) {
        throw new Error(`CGI lifetime request ${round}: unexpected response fields`);
      }
      for (const [field, value] of Object.entries(expected)) {
        if (actual[field] !== value) {
          throw new Error(`CGI lifetime request ${round}: ${field} changed`);
        }
      }
    }));
  }
  return { requests: 32, concurrency: 4 };
}

/** A test deadline must not retain its timer after the operation completes. */
export async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
