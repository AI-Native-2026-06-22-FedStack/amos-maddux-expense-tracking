import { localDevAuthFixture } from "./local-dev-auth-fixture.mjs";

console.log(
  [
    "ExpenseFlow local synthetic sign-in",
    `Tenant ID: ${localDevAuthFixture.tenantId}`,
    `Email: ${localDevAuthFixture.email}`,
    `Password: ${localDevAuthFixture.password}`,
    "MFA code: run `npm run compose:mfa`"
  ].join("\n")
);
