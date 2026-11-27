import { describe, expect, it } from "vitest";

import { SIDE_MODULE_FORMS, sharedSideModuleKey } from "../src/shared-side-module";

describe("sharedSideModuleKey", () => {
  it("writes each byte of the template id as two hex digits", () => {
    expect(sharedSideModuleKey(Uint8Array.of(0x00, 0x0f, 0xa0, 0xff), "plain"))
      .toBe("000fa0ff:plain");
  });

  it("separates the forms of one template id", () => {
    const templateId = Uint8Array.of(1, 2, 3);

    const keys = SIDE_MODULE_FORMS.map((form) => sharedSideModuleKey(templateId, form));

    expect(new Set(keys).size).toBe(SIDE_MODULE_FORMS.length);
  });
});
