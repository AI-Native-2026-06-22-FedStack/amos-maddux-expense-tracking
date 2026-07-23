import { generate } from "otplib";

import { localDevAuthFixture } from "./local-dev-auth-fixture.mjs";

const mfaCode = await generate({
  secret: localDevAuthFixture.mfaSecret,
  digits: 6,
  period: 30
});

console.log(mfaCode);
