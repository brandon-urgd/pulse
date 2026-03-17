#!/usr/bin/env python3
"""
register-with-shield.py — Register the Pulse Shield callback Lambda with the ur/gd Shield service.

Registers the shieldCallback Lambda ARN so that the Shield malware scanning
pipeline can invoke it when a GuardDuty scan completes on the quarantine bucket.

Usage:
    python3 scripts/register-with-shield.py \\
        --lambda-arn arn:aws:lambda:us-west-2:123456789012:function:urgd-pulse-shieldCallback-dev \\
        --bucket-name urgd-pulse-quarantine-dev \\
        --environment dev

Environment variables:
    SHIELD_REGISTRATION_URL  — Shield service registration endpoint (required)

Requirements: 4.2
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Register the Pulse Shield callback Lambda with the ur/gd Shield service"
    )
    parser.add_argument(
        "--lambda-arn",
        required=True,
        help="ARN of the urgd-pulse-shieldCallback Lambda function",
    )
    parser.add_argument(
        "--bucket-name",
        required=True,
        help="Name of the Shield quarantine S3 bucket",
    )
    parser.add_argument(
        "--environment",
        required=True,
        choices=["dev", "staging", "prod"],
        help="Deployment environment",
    )
    return parser.parse_args()


def get_registration_url() -> str:
    url = os.environ.get("SHIELD_REGISTRATION_URL", "").strip()
    if not url:
        print(
            "❌ SHIELD_REGISTRATION_URL environment variable is not set",
            file=sys.stderr,
        )
        sys.exit(1)
    return url


def register(lambda_arn: str, bucket_name: str, environment: str, registration_url: str) -> None:
    payload = {
        "app": "pulse",
        "environment": environment,
        "callbackLambdaArn": lambda_arn,
        "quarantineBucket": bucket_name,
    }

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        registration_url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": "urgd-pulse-deploy/1.0",
        },
    )

    print(f"🔗 Registering Shield callback with: {registration_url}")
    print(f"   Lambda ARN:  {lambda_arn}")
    print(f"   Bucket:      {bucket_name}")
    print(f"   Environment: {environment}")

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            status = response.status
            response_body = response.read().decode("utf-8")

            if status in (200, 201, 204):
                print(f"✅ Shield registration successful (HTTP {status})")
                if response_body:
                    try:
                        data = json.loads(response_body)
                        print(f"   Response: {json.dumps(data, indent=2)}")
                    except json.JSONDecodeError:
                        print(f"   Response: {response_body}")
            else:
                print(
                    f"❌ Shield registration returned unexpected status: HTTP {status}",
                    file=sys.stderr,
                )
                print(f"   Response: {response_body}", file=sys.stderr)
                sys.exit(1)

    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8") if e.fp else ""
        print(
            f"❌ Shield registration failed: HTTP {e.code} {e.reason}",
            file=sys.stderr,
        )
        if error_body:
            print(f"   Response: {error_body}", file=sys.stderr)
        sys.exit(1)

    except urllib.error.URLError as e:
        print(
            f"❌ Shield registration request failed: {e.reason}",
            file=sys.stderr,
        )
        sys.exit(1)


def main() -> None:
    args = parse_args()
    registration_url = get_registration_url()
    register(
        lambda_arn=args.lambda_arn,
        bucket_name=args.bucket_name,
        environment=args.environment,
        registration_url=registration_url,
    )


if __name__ == "__main__":
    main()
