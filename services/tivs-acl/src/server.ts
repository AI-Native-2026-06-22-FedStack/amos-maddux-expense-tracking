import { createServer } from "node:http";

import { createTivsAclApp } from "./app.js";
import { loadTivsRuntimeConfig } from "./config.js";
import { createExpenseFlowTaxpayerVerificationGateway } from "./index.js";

const config = loadTivsRuntimeConfig();
const gateway = await createExpenseFlowTaxpayerVerificationGateway(config);
const app = createTivsAclApp(gateway);
const server = createServer(app);

server.listen(config.port, () => {
  console.info(`TIVS ACL listening on port ${config.port}.`);
});
