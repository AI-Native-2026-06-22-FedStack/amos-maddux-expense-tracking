// Ad-hoc script for manually poking the receipt-upload S3 bucket during local
// debugging. Not wired into any npm script; run directly with `node`.
//
// Credentials come from the standard AWS SDK environment/credential-chain
// lookup (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_ENDPOINT_URL in
// .env, matching every other host-side AWS call in this repo) — never
// hardcode a key pair here.
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const client = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

const result = await client.send(
  new ListObjectsV2Command({ Bucket: "expenseflow-receipts-debug" })
);

console.log(result.Contents ?? []);
