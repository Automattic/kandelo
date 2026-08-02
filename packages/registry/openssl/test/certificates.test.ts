import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  certificateToPEM,
  generateCertificate,
} from "../src/tls/certificates";

async function parsedSerialNumber(serialNumber: number[]): Promise<string> {
  const generated = await generateCertificate({
    subject: { commonName: "der-integer.test" },
    serialNumber: new Uint8Array(serialNumber),
  });
  return new X509Certificate(
    certificateToPEM(generated.certificate),
  ).serialNumber;
}

describe("certificate DER INTEGER encoding", () => {
  it.each([
    {
      label: "removes one redundant leading zero",
      input: [0x00, 0x01],
      expected: "01",
    },
    {
      label: "removes several redundant leading zeroes",
      input: [0x00, 0x00, 0x01],
      expected: "01",
    },
    {
      label: "keeps the zero value",
      input: [0x00],
      expected: "0",
    },
    {
      label: "keeps a required positive sign byte",
      input: [0x00, 0x80],
      expected: "80",
    },
    {
      label: "accepts the largest value below the sign boundary",
      input: [0x7f],
      expected: "7F",
    },
    {
      label: "treats the sign-boundary byte as an unsigned magnitude",
      input: [0x80],
      expected: "80",
    },
    {
      label: "does not misencode an all-high-bit magnitude as negative",
      input: [0xff],
      expected: "FF",
    },
    {
      label: "reduces multiple zeroes to the canonical zero value",
      input: [0x00, 0x00, 0x00],
      expected: "0",
    },
  ])("$label", async ({ input, expected }) => {
    expect(await parsedSerialNumber(input)).toBe(expected);
  });

  it("rejects an empty unsigned magnitude", async () => {
    await expect(parsedSerialNumber([])).rejects.toThrow(
      "ASN.1 INTEGER magnitude must not be empty",
    );
  });
});
