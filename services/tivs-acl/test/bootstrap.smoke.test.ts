import { describe, expect, it } from "vitest";

import { loadTivsRuntimeConfig } from "../src/config.js";

describe("TIVS ACL bootstrap", () => {
  it("loads TIVS config from the environment", () => {
    const config = loadTivsRuntimeConfig({
      TIVS_WSDL_URL: "https://synthetic-tivs.example.test/tivs?wsdl"
    });

    expect(config.wsdlUrl).toBe("https://synthetic-tivs.example.test/tivs?wsdl");
  });
});
