# 0010 - TIVS WSDL Verification

- **_Asked:_** Read the hosted TIVS WSDL, verify both SOAP operations against the source
  declarations, and begin ADR-0015 with the operation types, declared fault, and brownfield smells.

- **_Produced:_** Fetched `TIVS_WSDL_URL`, checked the `message`, `element`, `portType`, and
  `binding` declarations operation by operation, and recorded the results in ADR-0015.

- **_Accepted / Rejected:_** ACCEPTED: Treat the first Codex operation summary as a hypothesis only.
  ACCEPTED: Check the no-fault claim for `VerifyTaxpayer` first. REJECTED: relying on SOAP intuition
  or fixture behavior without confirming the WSDL declarations.

- **_Discrepancy check:_** No discrepancy was found between the first Codex hypothesis and the WSDL
  source. The source confirmed `TaxpayerNotFoundFault` on `GetTaxpayerStatus` only, and confirmed
  that `VerifyTaxpayer` returns unknown TIN as match code `2` rather than declaring a fault.

- **_Why:_** The ACL must absorb TIVS brownfield behavior: numeric-string `MatchCode`, `MMDDYYYY`
  `AsOfDate`, and the code-versus-fault inconsistency for unknown TINs.
