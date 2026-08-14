// Ad-hoc script for manually poking the receipt-upload S3 bucket during local
// debugging. Not wired into any npm script; run directly with `node`.
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const client = new S3Client({
  region: "us-east-1",
  credentials: {
    accessKeyId: "AKIAHBRPOIGF3CBFNOBM",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  }
});

const result = await client.send(
  new ListObjectsV2Command({ Bucket: "expenseflow-receipts-debug" })
);

console.log(result.Contents ?? []);
