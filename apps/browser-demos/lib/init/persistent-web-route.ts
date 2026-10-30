export function persistentWebRouteLock(scopePath: string, name: string): string {
  return `kandelo-http-route:${scopePath}${name}`;
}

export async function persistentWebRouteName(scopePath: string, computerName: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(computerName)) {
    throw new Error("invalid persistent computer name");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(["kandelo-persistent-web-v1", scopePath, computerName]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `p-${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
