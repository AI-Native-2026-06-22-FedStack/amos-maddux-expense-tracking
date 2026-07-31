import { describe, expect, it } from "vitest";

const expectedWsdlUrl = "https://d2xnf2iv2yptek.cloudfront.net/tivs?wsdl";

describe("TIVS ACL bootstrap", () => {
  it("has the shared TIVS WSDL URL available for local bootstrap", () => {
    const configuredWsdlUrl = process.env.TIVS_WSDL_URL ?? expectedWsdlUrl;

    expect(configuredWsdlUrl).toBe(expectedWsdlUrl);
  });
});
