#!/usr/bin/env python3
"""Round-trip proof: read the Parquet archive back from floci S3 and check
that identifier columns are still strings (leading zeros intact) and the
money column is still an exact integer, not a float.
"""

from __future__ import annotations

import argparse

import polars as pl


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", default="spend-aggregate")
    parser.add_argument("--endpoint-url", default="http://localhost:4566")
    args = parser.parse_args()

    storage_options = {
        "aws_access_key_id": "test",
        "aws_secret_access_key": "test",
        "aws_region": "us-east-1",
        "aws_endpoint_url": args.endpoint_url,
        "aws_allow_http": "true",
    }

    df = pl.scan_parquet(
        f"s3://{args.bucket}/{args.prefix}/**/*.parquet",
        hive_partitioning=True,
        storage_options=storage_options,
    ).collect()

    print("schema:", df.schema)
    print("row count:", df.height)
    print("total spend_cents:", df["spend_cents"].sum())
    print("total line_item_count:", df["line_item_count"].sum())
    print("distinct tenant count:", df["tenant_id"].n_unique())

    gl_codes = df["gl_account_code"].unique().to_list()
    leading_zero_codes = sorted(v for v in gl_codes if v.startswith("0"))
    print("leading-zero gl_account_code values present:", leading_zero_codes)

    assert df.schema["tenant_id"] == pl.String, "tenant_id must round-trip as String"
    assert df.schema["gl_account_code"] == pl.String, "gl_account_code must round-trip as String"
    assert df.schema["spend_cents"] == pl.Int64, "spend_cents must round-trip as exact Int64"
    assert leading_zero_codes, "expected at least one leading-zero gl_account_code to survive"

    print("\nCONFIRMED: identifier columns are strings (leading zeros intact); "
          "money column is exact Int64, not float.")


if __name__ == "__main__":
    main()
