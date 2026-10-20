declare module "cloudflare:sockets" {
  export function connect(address: { hostname: string; port: number },
    options: { secureTransport: "off" | "starttls"; allowHalfOpen: boolean }): import("./pinned-fetch.ts").Socket;
}
