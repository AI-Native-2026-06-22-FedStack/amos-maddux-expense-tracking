# ADR-0015: TIVS SOAP ACL Contract Verification

## Status

Accepted

## Context

ExpenseFlow must wrap the legacy Federal Taxpayer Identification Verification Service (TIVS) SOAP
contract behind `services/tivs-acl`. The WSDL at `TIVS_WSDL_URL` is the authoritative source for the
operations, message wrappers, declared faults, and brownfield representations the ACL must absorb.

Codex's first contract summary was treated only as a hypothesis: TIVS exposes `VerifyTaxpayer` and
`GetTaxpayerStatus`; `VerifyTaxpayer` accepts `TIN`, `TINType`, and `LegalName` and returns
`MatchCode`, optional `VerifiedName`, and `TINType`; `GetTaxpayerStatus` accepts `TIN` and `TINType`
and returns `Standing` and `AsOfDate`; only `GetTaxpayerStatus` declares `TaxpayerNotFoundFault`.

## Decision

ExpenseFlow will implement TIVS access through an anti-corruption layer that maps the SOAP contract
into clean domain types. No caller outside the ACL should reason about SOAP wrapper names, numeric
string match codes, legacy date strings, or SOAP fault shapes.

### Verification Trail

Source checked: `https://d2xnf2iv2yptek.cloudfront.net/tivs?wsdl`, fetched on July 31, 2026.

Fault check, performed first:

- `VerifyTaxpayer` declares no fault. The `wsdl:portType` operation has only
  `tns:VerifyTaxpayerRequest` input and `tns:VerifyTaxpayerResponse` output, and the matching
  `wsdl:binding` operation has only literal input and output bodies.
- `GetTaxpayerStatus` declares `TaxpayerNotFoundFault` only. The `wsdl:portType` operation includes
  `wsdl:fault name="TaxpayerNotFoundFault" message="tns:TaxpayerNotFoundFault"`, and the binding
  includes a matching literal `soap:fault`.
- The fault message is `TaxpayerNotFoundFault` with part `fault` bound to element
  `tns:TaxpayerNotFoundFault`. The element contains `FaultCode`, `FaultReason`, and `TIN`.

Operation verification:

| Operation           | WSDL message declarations                                                                                                                          | Element declarations confirmed                                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VerifyTaxpayer`    | Request message part `parameters` points to `tns:VerifyTaxpayer`; response message part `parameters` points to `tns:VerifyTaxpayerResponse`.       | Request element contains `TIN` as `xsd:string`, `TINType` as `tns:TINTypeCode`, and `LegalName` as `xsd:string`. Response element contains `MatchCode` as `tns:MatchCodeType`, optional `VerifiedName` as `xsd:string` with `minOccurs="0"`, and `TINType` as `tns:TINTypeCode`. |
| `GetTaxpayerStatus` | Request message part `parameters` points to `tns:GetTaxpayerStatus`; response message part `parameters` points to `tns:GetTaxpayerStatusResponse`. | Request element contains `TIN` as `xsd:string` and `TINType` as `tns:TINTypeCode`. Response element contains `Standing` as `tns:StandingCode` and `AsOfDate` as `xsd:string`.                                                                                                    |

Type verification:

- `TINTypeCode` is an `xsd:string` enumeration with `EIN` and `SSN`.
- `MatchCodeType` is an `xsd:string` enumeration with `0`, `1`, `2`, and `3`.
- `StandingCode` is an `xsd:string` enumeration with `ACTIVE`, `INACTIVE`, and `SUSPENDED`.

Brownfield smells recorded for the ACL:

- `MatchCode` is a numeric string, not a number or descriptive enum: `0` means match, `1` means TIN
  not issued, `2` means TIN not found, and `3` means TIN/name mismatch.
- `AsOfDate` is an `MMDDYYYY` string, not an ISO date.
- Unknown TIN handling is inconsistent: `VerifyTaxpayer` returns match code `2`, while
  `GetTaxpayerStatus` raises `TaxpayerNotFoundFault`.
- The WSDL service address still advertises `http://localhost:8081/tivs`; clients must override it
  with the hosted HTTPS endpoint at runtime instead of changing the WSDL.

No discrepancy was found between the initial Codex hypothesis and the source WSDL after checking the
`message`, `element`, `portType`, and `binding` declarations operation by operation.

## Alternatives Considered

- Trusting the first summary: Rejected because SOAP contracts can hide important behavior in
  message, element, binding, or fault declarations.
- Mapping WSDL shapes directly into ExpenseFlow callers: Rejected because the rest of ExpenseFlow
  should not depend on numeric string match codes, non-ISO date strings, or SOAP fault behavior.
- Treating unknown TIN uniformly before the ACL: Rejected because the source contract is not uniform;
  the ACL must normalize `VerifyTaxpayer` code `2` and `GetTaxpayerStatus` fault behavior.

## Consequences

POSITIVE: The TIVS ACL has a verified source contract before implementation begins.
POSITIVE: The highest-risk claim, no declared `VerifyTaxpayer` fault, is explicitly documented.
POSITIVE: ExpenseFlow domain code can be insulated from brownfield SOAP representations.
NEGATIVE: The ACL must maintain explicit translation logic for legacy codes, legacy date strings,
and operation-specific unknown-TIN behavior.
