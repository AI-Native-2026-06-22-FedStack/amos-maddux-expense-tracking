#!/usr/bin/env python3
"""Write the spend aggregate to Hive-partitioned Parquet and upload it to floci S3.

Partitioned by tenant_id, then month: every finance query in this codebase
scopes to one tenant first (see apps/api's tenant-isolation pattern
throughout), and "spend for tenant X" / "spend for tenant X in month Y" are
the two access patterns this archive exists to serve. Partitioning this way
lets a partition-aware reader (e.g. `pl.scan_parquet(..., hive_partitioning=True)`
with a tenant_id/month filter) skip whole files it doesn't need, rather than
reading the entire archive and filtering afterward.

Usage:
    python tools/archive_to_parquet.py <export_path> --bucket <bucket-name>
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import polars as pl

PIPELINE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PIPELINE_DIR))

from aggregate import aggregate_polars  # noqa: E402

PARTITION_COLUMNS = ["tenant_id", "month"]


def write_partitioned_parquet(export_path: Path, out_dir: Path) -> Path:
    """Run the aggregate and write it as a Hive-partitioned Parquet dataset."""
    result = aggregate_polars(export_path)
    df = pl.from_pandas(result.spend_by_tenant_gl_month)

    dataset_dir = out_dir / "spend"
    df.write_parquet(dataset_dir, partition_by=PARTITION_COLUMNS, mkdir=True)
    return dataset_dir


def upload_to_floci(dataset_dir: Path, bucket: str, prefix: str, endpoint_url: str) -> None:
    subprocess.run(
        [
            "aws",
            "--endpoint-url",
            endpoint_url,
            "s3",
            "sync",
            str(dataset_dir),
            f"s3://{bucket}/{prefix}",
        ],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export_path", type=Path)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", default="spend-aggregate")
    parser.add_argument("--endpoint-url", default="http://localhost:4566")
    parser.add_argument(
        "--keep-local",
        type=Path,
        default=None,
        help="If set, copy the written Parquet dataset here instead of a temp dir that gets "
        "deleted.",
    )
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        dataset_dir = write_partitioned_parquet(args.export_path, Path(tmp))
        print(f"wrote partitioned Parquet dataset to {dataset_dir}")

        for path in sorted(dataset_dir.rglob("*.parquet")):
            print(f"  {path.relative_to(dataset_dir)}")

        if args.keep_local is not None:
            shutil.copytree(dataset_dir, args.keep_local, dirs_exist_ok=True)

        upload_to_floci(dataset_dir, args.bucket, args.prefix, args.endpoint_url)
        print(f"uploaded to s3://{args.bucket}/{args.prefix}")


if __name__ == "__main__":
    main()
