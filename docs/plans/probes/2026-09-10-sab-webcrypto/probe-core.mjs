// Does SubtleCrypto accept a view backed by a SharedArrayBuffer?
//
// WHY this probe exists: the host typecheck reports nine errors where TLS code
// passes `Uint8Array<ArrayBufferLike>` to `crypto.subtle.*`, which requires
// `BufferSource` — a type that excludes SharedArrayBuffer. In Kandelo a guest's
// memory IS a SharedArrayBuffer, so if TLS key material ever reaches those
// calls as a view over guest memory rather than a copy, the call fails at
// runtime. The type system says it is possible; only an engine can say whether
// it actually throws.
//
// Each row reports what the engine DID, not what the spec says it should do.
export async function runSabWebCryptoProbe(subtle) {
  const rows = [];
  const record = async (name, fn) => {
    try {
      await fn();
      rows.push({ name, outcome: "accepted" });
    } catch (error) {
      rows.push({
        name,
        outcome: "threw",
        error: `${error?.name ?? "Error"}: ${String(error?.message ?? error).slice(0, 120)}`,
      });
    }
  };

  const sab = new SharedArrayBuffer(32);
  const sabView = new Uint8Array(sab);
  sabView.fill(7);

  const plain = new Uint8Array(32);
  plain.fill(7);

  // Control: a normal ArrayBuffer-backed view must be accepted, or the probe
  // itself is broken and every other row is meaningless.
  await record("control_plain_digest", () => subtle.digest("SHA-256", plain));
  await record("control_plain_importKey", () =>
    subtle.importKey("raw", plain, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));

  await record("sab_digest", () => subtle.digest("SHA-256", sabView));
  await record("sab_importKey", () =>
    subtle.importKey("raw", sabView, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));

  // The copy that a fix would introduce, to confirm it is a real remedy.
  await record("sab_copied_then_importKey", () =>
    subtle.importKey("raw", sabView.slice(), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));

  // Signing over SAB-backed data, which is the TLS PRF's actual shape.
  await record("sab_sign", async () => {
    const key = await subtle.importKey("raw", plain, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    await subtle.sign("HMAC", key, sabView);
  });

  return rows;
}
