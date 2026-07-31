import type {
  ExpenseFlowTaxpayerVerificationGateway,
  TaxpayerStatusNotFoundError,
  TaxpayerStandingRequest,
  TaxpayerStandingResult,
  TaxpayerVerificationRequest,
  TaxpayerVerificationResult
} from "./index.js";
import type { TivsSoapOperations } from "./client.js";

type Assert<T extends true> = T;
type IsExact<T, U> =
  (<V>() => V extends T ? 1 : 2) extends <V>() => V extends U ? 1 : 2
    ? (<V>() => V extends U ? 1 : 2) extends <V>() => V extends T ? 1 : 2
      ? true
      : false
    : false;

type GatewayVerify = ExpenseFlowTaxpayerVerificationGateway["verifyTaxpayer"];
type GatewayStatus = ExpenseFlowTaxpayerVerificationGateway["getTaxpayerStanding"];

type SoapVerify = TivsSoapOperations["verifyTaxpayer"];
type SoapStatus = TivsSoapOperations["getTaxpayerStatus"];
type PublicModule = typeof import("./index.js");

type _VerifyRequestIsCapstoneDto = Assert<
  IsExact<Parameters<GatewayVerify>[0], TaxpayerVerificationRequest>
>;
type _VerifyResponseIsCapstoneDto = Assert<
  IsExact<Awaited<ReturnType<GatewayVerify>>, TaxpayerVerificationResult>
>;
type _StatusRequestIsCapstoneDto = Assert<
  IsExact<Parameters<GatewayStatus>[0], TaxpayerStandingRequest>
>;
type _StatusResponseIsCapstoneDto = Assert<
  IsExact<Awaited<ReturnType<GatewayStatus>>, TaxpayerStandingResult>
>;

type _VerifyRequestDoesNotLeakSoapShape = Assert<
  IsExact<Parameters<GatewayVerify>[0], Parameters<SoapVerify>[0]> extends true ? false : true
>;
type _VerifyResponseDoesNotLeakSoapShape = Assert<
  IsExact<Awaited<ReturnType<GatewayVerify>>, Awaited<ReturnType<SoapVerify>>> extends true
    ? false
    : true
>;
type _StatusRequestDoesNotLeakSoapShape = Assert<
  IsExact<Parameters<GatewayStatus>[0], Parameters<SoapStatus>[0]> extends true ? false : true
>;
type _StatusResponseDoesNotLeakSoapShape = Assert<
  IsExact<Awaited<ReturnType<GatewayStatus>>, Awaited<ReturnType<SoapStatus>>> extends true
    ? false
    : true
>;

type _PublicSurfaceIncludesDomainError = Assert<
  IsExact<InstanceType<typeof TaxpayerStatusNotFoundError>["kind"], "taxpayer-status-not-found">
>;
type _PublicSurfaceDoesNotExportRawSoapClient = Assert<
  "createTivsSoapClient" extends keyof PublicModule ? false : true
>;
type _PublicSurfaceDoesNotExportRawSoapOperations = Assert<
  "TivsSoapOperations" extends keyof PublicModule ? false : true
>;
