# WebRTC DataChannel demo

Two browsers exchange SDP by copy-paste, open an `RTCDataChannel`, and
chat peer-to-peer. No kernel involvement, no signaling server, no
third-party libraries.

## Why HTTPS on the LAN

The dev server defaults to `http://localhost:5173`. A second LAN peer
loading `http://<host-lan-ip>:5173` is **not in a secure context**, so
both `RTCPeerConnection` (host-candidate gathering, mDNS) and
`SharedArrayBuffer` (the rest of the demos) are restricted. Serving the
dev server over HTTPS with a cert the peer trusts fixes both.

## Generate a cert

### mkcert

[mkcert](https://github.com/FiloSottile/mkcert) installs a per-user
local CA. After `mkcert -install` on both machines, every browser on
both treats the dev server as a secure origin.

```bash
brew install mkcert nss     # nss is needed for Firefox trust
mkcert -install              # once per machine — installs the local CA
mkdir -p "$HOME/.local/share/wasm-posix-kernel/certs"
cd "$HOME/.local/share/wasm-posix-kernel/certs"
mkcert -cert-file cert.pem -key-file key.pem localhost <your-lan-ip>
```

Replace `<your-lan-ip>` with whatever the peer types into its address
bar (add multiple names if needed). On the peer machine: either run
`mkcert -install` there too, or import `"$(mkcert -CAROOT)/rootCA.pem"`
into its trust store.

### Tailscale

If both machines are on the same Tailnet, `tailscale cert` issues a
publicly-trusted cert for the device's `*.ts.net` name — no CA install
needed on the peer.

```bash
tailscale cert --cert-file "$HOME/.local/share/wasm-posix-kernel/certs/cert.pem" \
               --key-file  "$HOME/.local/share/wasm-posix-kernel/certs/key.pem" \
               <your-machine>.<your-tailnet>.ts.net
```

## Run the dev server

```bash
cd examples/browser
VITE_HTTPS=1 npx vite --host
```

`--host` makes Vite listen on every interface (default is `localhost`
only). `VITE_HTTPS=1` reads
`$HOME/.local/share/wasm-posix-kernel/certs/{cert.pem,key.pem}` and
serves HTTPS. If either file is missing the dev server fails at
startup with a pointer back to this file. With `VITE_HTTPS` unset the
dev server is HTTP exactly as before — no behavior change for any
other demo.

## Troubleshooting

- **`SharedArrayBuffer is not defined`.** The page is not in a secure
  context — either loading over plain HTTP from a non-`localhost`
  origin, or the browser hasn't trusted the cert.
- **Connection state goes straight to `failed`.** ICE pairing problem.
  Open `chrome://webrtc-internals` (or `about:webrtc` in Firefox) on
  both peers to see exactly which candidate pair failed. Firefox needs
  "Access your local network" granted for the origin; if previously
  denied, revoke via Settings → Privacy → Manage Cookies and Site Data,
  or `about:config`.
