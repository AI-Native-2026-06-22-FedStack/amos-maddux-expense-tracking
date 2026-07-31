import { describe, expect, it, vi } from "vitest";

import { createTivsSoapClient } from "./client.js";
import type { TivsRuntimeConfig } from "./config.js";

const config: TivsRuntimeConfig = {
  endpointUrl: "https://synthetic-endpoint.example.test/tivs",
  wsdlUrl: "https://synthetic-wsdl.example.test/tivs?wsdl"
};

describe("createTivsSoapClient", () => {
  it("builds from the configured WSDL URL and sets the configured endpoint", async () => {
    const fakeClient = createFakeSoapClient();
    const createClient = vi.fn().mockResolvedValue(fakeClient);

    await createTivsSoapClient(config, { createClient });

    expect(createClient).toHaveBeenCalledWith(config.wsdlUrl);
    expect(fakeClient.setEndpoint).toHaveBeenCalledWith(config.endpointUrl);
  });

  it("exposes VerifyTaxpayer through the narrow interface", async () => {
    const fakeClient = createFakeSoapClient();
    const tivsClient = await createTivsSoapClient(config, {
      createClient: async () => fakeClient
    });
    const request = {
      LegalName: "SYNTHETIC GOVERNMENT SERVICES LLC",
      TIN: "12-3456789",
      TINType: "EIN" as const
    };

    const response = await tivsClient.verifyTaxpayer(request);

    expect(fakeClient.VerifyTaxpayerAsync).toHaveBeenCalledWith(request);
    expect(response).toEqual({
      body: {
        MatchCode: "0",
        TINType: "EIN",
        VerifiedName: "SYNTHETIC GOVERNMENT SERVICES LLC"
      },
      rawRequestXml: "<VerifyTaxpayer/>",
      rawResponseXml: "<VerifyTaxpayerResponse/>"
    });
  });

  it("exposes GetTaxpayerStatus through the narrow interface", async () => {
    const fakeClient = createFakeSoapClient();
    const tivsClient = await createTivsSoapClient(config, {
      createClient: async () => fakeClient
    });
    const request = {
      TIN: "12-3456789",
      TINType: "EIN" as const
    };

    const response = await tivsClient.getTaxpayerStatus(request);

    expect(fakeClient.GetTaxpayerStatusAsync).toHaveBeenCalledWith(request);
    expect(response).toEqual({
      body: {
        AsOfDate: "01152026",
        Standing: "ACTIVE"
      },
      rawRequestXml: "<GetTaxpayerStatus/>",
      rawResponseXml: "<GetTaxpayerStatusResponse/>"
    });
  });

  it("configures WS-Security when credentials are present", async () => {
    const fakeClient = createFakeSoapClient();

    await createTivsSoapClient(
      {
        ...config,
        password: "synthetic-password",
        username: "synthetic-user"
      },
      { createClient: async () => fakeClient }
    );

    expect(fakeClient.setSecurity).toHaveBeenCalledOnce();
  });
});

function createFakeSoapClient() {
  return {
    GetTaxpayerStatusAsync: vi.fn().mockResolvedValue([
      {
        AsOfDate: "01152026",
        Standing: "ACTIVE"
      },
      "<GetTaxpayerStatusResponse/>",
      undefined,
      "<GetTaxpayerStatus/>"
    ]),
    VerifyTaxpayerAsync: vi.fn().mockResolvedValue([
      {
        MatchCode: "0",
        TINType: "EIN",
        VerifiedName: "SYNTHETIC GOVERNMENT SERVICES LLC"
      },
      "<VerifyTaxpayerResponse/>",
      undefined,
      "<VerifyTaxpayer/>"
    ]),
    setEndpoint: vi.fn(),
    setSecurity: vi.fn()
  };
}
