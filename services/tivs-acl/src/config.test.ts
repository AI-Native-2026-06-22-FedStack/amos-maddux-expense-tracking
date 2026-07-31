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
      breakerErrorThresholdPercentage: 50,
      breakerResetTimeoutMs: 5000,
      breakerTimeoutMs: 1000,
      breakerVolumeThreshold: 3,
      endpointUrl: "https://synthetic-tivs.example.test/tivs",
      port: 3015,
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

  it("loads circuit breaker knobs from the environment", () => {
    const config = loadTivsRuntimeConfig({
      PORT: "3999",
      TIVS_BREAKER_ERROR_THRESHOLD_PERCENTAGE: "60",
      TIVS_BREAKER_RESET_TIMEOUT_MS: "7000",
      TIVS_BREAKER_TIMEOUT_MS: "250",
      TIVS_BREAKER_VOLUME_THRESHOLD: "4",
      TIVS_WSDL_URL: "https://synthetic-tivs.example.test/tivs?wsdl"
    });

    expect(config).toMatchObject({
      breakerErrorThresholdPercentage: 60,
      breakerResetTimeoutMs: 7000,
      breakerTimeoutMs: 250,
      breakerVolumeThreshold: 4,
      port: 3999
    });
  });

  it("requires the breaker volume threshold to be greater than one", () => {
    expect(() =>
      loadTivsRuntimeConfig({
        TIVS_BREAKER_VOLUME_THRESHOLD: "1",
        TIVS_WSDL_URL: "https://synthetic-tivs.example.test/tivs?wsdl"
      })
    ).toThrow("TIVS_BREAKER_VOLUME_THRESHOLD");
  });
});
