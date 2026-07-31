import CircuitBreaker from "opossum";

import type { TivsRuntimeConfig } from "./config.js";
import type {
  GetTaxpayerStatusSoapRequest,
  GetTaxpayerStatusSoapResult,
  RawSoapResponse,
  TivsSoapOperations,
  VerifyTaxpayerSoapRequest,
  VerifyTaxpayerSoapResult
} from "./client.js";

export function createResilientTivsSoapOperations(
  soapOperations: TivsSoapOperations,
  config: Pick<
    TivsRuntimeConfig,
    | "breakerErrorThresholdPercentage"
    | "breakerResetTimeoutMs"
    | "breakerTimeoutMs"
    | "breakerVolumeThreshold"
  >
): TivsSoapOperations {
  const options = {
    errorThresholdPercentage: config.breakerErrorThresholdPercentage,
    resetTimeout: config.breakerResetTimeoutMs,
    timeout: config.breakerTimeoutMs,
    volumeThreshold: config.breakerVolumeThreshold
  };

  // Opossum timeouts can race the underlying SOAP request. TIVS operations are read-only lookups,
  // so retrying or abandoning a timed-out call does not create duplicate side effects.
  const verifyTaxpayerBreaker = new CircuitBreaker(
    (request: VerifyTaxpayerSoapRequest) => soapOperations.verifyTaxpayer(request),
    options
  );
  const getTaxpayerStatusBreaker = new CircuitBreaker(
    (request: GetTaxpayerStatusSoapRequest) => soapOperations.getTaxpayerStatus(request),
    options
  );

  return {
    getTaxpayerStatus(
      request: GetTaxpayerStatusSoapRequest
    ): Promise<RawSoapResponse<GetTaxpayerStatusSoapResult>> {
      return getTaxpayerStatusBreaker.fire(request);
    },
    verifyTaxpayer(
      request: VerifyTaxpayerSoapRequest
    ): Promise<RawSoapResponse<VerifyTaxpayerSoapResult>> {
      return verifyTaxpayerBreaker.fire(request);
    }
  };
}
