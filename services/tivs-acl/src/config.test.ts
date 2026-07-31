import { describe, expect, it } from "vitest";

import { loadTivsRuntimeConfig } from "./config.js";

describe("loadTivsRuntimeConfig", () => {
  it("requires TIVS_WSDL_URL", () => {
    expect(() => loadTivsRuntimeConfig({})).toThrow("TIVS_WSDL_URL is required.");
  });

  it("loads the WSDL URL and derives the endpoint without hardcoding the host", () => {
    const config = loadTivsRuntimeConfig({
      TIVS_WSDL_URL: "https://synthetic-tivs.example.test/tivs?wsdl"
    });

    expect(config).toEqual({
      endpointUrl: "https://synthetic-tivs.example.test/tivs",
      wsdlUrl: "https://synthetic-tivs.example.test/tivs?wsdl"
    });
  });

  it("allows the endpoint to be overridden from config", () => {
    const config = loadTivsRuntimeConfig({
      TIVS_ENDPOINT_URL: "https://synthetic-endpoint.example.test/tivs",
      TIVS_WSDL_URL: "https://synthetic-wsdl.example.test/tivs?wsdl"
    });

    expect(config.endpointUrl).toBe("https://synthetic-endpoint.example.test/tivs");
  });

  it("requires WS-Security credentials to be configured together", () => {
    expect(() =>
      loadTivsRuntimeConfig({
        TIVS_USERNAME: "synthetic-user",
        TIVS_WSDL_URL: "https://synthetic-tivs.example.test/tivs?wsdl"
      })
    ).toThrow("TIVS_USERNAME and TIVS_PASSWORD must be configured together.");
  });
});
