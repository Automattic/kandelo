import { createHmac, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "../playwright-test";

function prfReference(secret: Uint8Array, seed: Uint8Array, length: number): string {
  let a = Buffer.from(seed), output = Buffer.alloc(0);
  while (output.length < length) {
    a = createHmac("sha256", secret).update(a).digest();
    output = Buffer.concat([output, createHmac("sha256", secret).update(a).update(seed).digest()]);
  }
  return output.subarray(0, length).toString("hex");
}

test("host TLS uses exact non-shared Fetch and WebCrypto byte ranges", async ({ page, baseURL }) => {
  test.setTimeout(30_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const sourceRoot = fileURLToPath(new URL("../../../host/src/networking/tls/", import.meta.url));
  const result = await page.evaluate(async ({ sourceRoot, baseURL }) => {
    const load = (name: string) => import(/* @vite-ignore */ new URL(`/@fs${sourceRoot}${name}`, baseURL).href);
    const { nonSharedBytes } = await load("shims.ts");
    const { tls12Prf } = await load("1_2/prf.ts");
    const { generateCertificate, certificateToPEM } = await load("certificates.ts");
    const privateBacking = new Uint8Array([99, 2, 3, 4, 88]);
    const privateBytes = nonSharedBytes(new DataView(privateBacking.buffer, 1, 3));
    const sharedBacking = new Uint8Array(new SharedArrayBuffer(5));
    sharedBacking.set([99, 2, 3, 4, 88]);
    const sharedBytes = nonSharedBytes(new DataView(sharedBacking.buffer, 1, 3));
    sharedBacking.fill(7);
    const digest = await crypto.subtle.digest("SHA-256", sharedBytes);
    const expectedDigest = await crypto.subtle.digest("SHA-256", new Uint8Array([2, 3, 4]));
    const secretBacking = new Uint8Array(new SharedArrayBuffer(6));
    secretBacking.set([99, 1, 2, 3, 4, 88]);
    const seedBacking = new Uint8Array([99, 5, 6, 7, 8, 88]);
    const prf = await tls12Prf(new DataView(secretBacking.buffer, 1, 4),
      new TextEncoder().encode("range proof"), new DataView(seedBacking.buffer, 1, 4), 64);
    const cert = await generateCertificate({ subject: { commonName: "range.test" }, serialNumber: new Uint8Array([0x80]) });
    return {
      privateBorrow: privateBytes.buffer === privateBacking.buffer,
      privateResponse: [...new Uint8Array(await new Response(privateBytes).arrayBuffer())],
      sharedPrivate: sharedBytes.buffer instanceof ArrayBuffer,
      sharedResponse: [...new Uint8Array(await new Response(sharedBytes).arrayBuffer())],
      digest: [...new Uint8Array(digest)], expectedDigest: [...new Uint8Array(expectedDigest)],
      prf: [...new Uint8Array(prf)].map(n => n.toString(16).padStart(2, "0")).join(""),
      certificate: certificateToPEM(cert.certificate),
    };
  }, { sourceRoot, baseURL: baseURL! });
  expect(result.privateBorrow).toBe(true);
  expect(result.privateResponse).toEqual([2, 3, 4]);
  expect(result.sharedPrivate).toBe(true);
  expect(result.sharedResponse).toEqual([2, 3, 4]);
  expect(result.digest).toEqual(result.expectedDigest);
  expect(result.prf).toBe(prfReference(new Uint8Array([1, 2, 3, 4]),
    new Uint8Array([...new TextEncoder().encode("range proof"), 5, 6, 7, 8]), 64));
  const certificate = new X509Certificate(result.certificate);
  expect(certificate.serialNumber).toBe("80");
  expect(certificate.verify(certificate.publicKey)).toBe(true);
  expect(errors).toEqual([]);
});
