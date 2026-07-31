import * as soap from "soap";

import type { TivsRuntimeConfig } from "./config.js";

export type TinTypeCode = "EIN" | "SSN";

interface VerifyTaxpayerSoapRequest {
  LegalName: string;
  TIN: string;
  TINType: TinTypeCode;
}

interface VerifyTaxpayerSoapResult {
  MatchCode: "0" | "1" | "2" | "3";
  TINType: TinTypeCode;
  VerifiedName?: string;
}

interface GetTaxpayerStatusSoapRequest {
  TIN: string;
  TINType: TinTypeCode;
}

interface GetTaxpayerStatusSoapResult {
  AsOfDate: string;
  Standing: "ACTIVE" | "INACTIVE" | "SUSPENDED";
}

interface RawSoapResponse<TResult> {
  body: TResult;
  rawRequestXml?: string;
  rawResponseXml?: string;
  soapHeader?: unknown;
}

export interface TivsSoapOperations {
  getTaxpayerStatus(
    request: GetTaxpayerStatusSoapRequest
  ): Promise<RawSoapResponse<GetTaxpayerStatusSoapResult>>;
  verifyTaxpayer(
    request: VerifyTaxpayerSoapRequest
  ): Promise<RawSoapResponse<VerifyTaxpayerSoapResult>>;
}

type SoapAsyncMethod<TRequest, TResult> = (
  request: TRequest
) => Promise<SoapAsyncTuple<TResult>>;

type SoapAsyncTuple<TResult> = [
  body: TResult,
  rawResponseXml?: string,
  soapHeader?: unknown,
  rawRequestXml?: string
];

type TivsNodeSoapClient = Pick<Client, "setEndpoint" | "setSecurity"> & {
  GetTaxpayerStatusAsync?: unknown;
  VerifyTaxpayerAsync?: unknown;
};

type Client = soap.Client;

interface CreateTivsSoapClientOptions {
  createClient?: (wsdlUrl: string) => Promise<TivsNodeSoapClient>;
}

export async function createTivsSoapClient(
  config: TivsRuntimeConfig,
  options: CreateTivsSoapClientOptions = {}
): Promise<TivsSoapOperations> {
  const createClient =
    options.createClient ??
    (async (wsdlUrl: string): Promise<TivsNodeSoapClient> => soap.createClientAsync(wsdlUrl));
  const client = await createClient(config.wsdlUrl);

  client.setEndpoint(config.endpointUrl);

  if (config.username !== undefined && config.password !== undefined) {
    client.setSecurity(new soap.WSSecurity(config.username, config.password));
  }

  return new NodeSoapTivsOperations(client);
}

class NodeSoapTivsOperations implements TivsSoapOperations {
  private readonly getTaxpayerStatusAsync: SoapAsyncMethod<
    GetTaxpayerStatusSoapRequest,
    GetTaxpayerStatusSoapResult
  >;
  private readonly verifyTaxpayerAsync: SoapAsyncMethod<
    VerifyTaxpayerSoapRequest,
    VerifyTaxpayerSoapResult
  >;

  constructor(client: TivsNodeSoapClient) {
    this.getTaxpayerStatusAsync = requireSoapAsyncMethod<
      GetTaxpayerStatusSoapRequest,
      GetTaxpayerStatusSoapResult
    >(client.GetTaxpayerStatusAsync, "GetTaxpayerStatusAsync");
    this.verifyTaxpayerAsync = requireSoapAsyncMethod<
      VerifyTaxpayerSoapRequest,
      VerifyTaxpayerSoapResult
    >(client.VerifyTaxpayerAsync, "VerifyTaxpayerAsync");
  }

  async getTaxpayerStatus(
    request: GetTaxpayerStatusSoapRequest
  ): Promise<RawSoapResponse<GetTaxpayerStatusSoapResult>> {
    return toRawSoapResponse(await this.getTaxpayerStatusAsync(request));
  }

  async verifyTaxpayer(
    request: VerifyTaxpayerSoapRequest
  ): Promise<RawSoapResponse<VerifyTaxpayerSoapResult>> {
    return toRawSoapResponse(await this.verifyTaxpayerAsync(request));
  }
}

function requireSoapAsyncMethod<TRequest, TResult>(
  method: unknown,
  methodName: string
): SoapAsyncMethod<TRequest, TResult> {
  if (typeof method !== "function") {
    throw new Error(`TIVS WSDL did not expose ${methodName}.`);
  }

  return method as SoapAsyncMethod<TRequest, TResult>;
}

function toRawSoapResponse<TResult>(
  response: SoapAsyncTuple<TResult>
): RawSoapResponse<TResult> {
  const [body, rawResponseXml, soapHeader, rawRequestXml] = response;

  return {
    body,
    ...(rawRequestXml === undefined ? {} : { rawRequestXml }),
    ...(rawResponseXml === undefined ? {} : { rawResponseXml }),
    ...(soapHeader === undefined ? {} : { soapHeader })
  };
}
