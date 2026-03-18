#!/usr/bin/env python3
"""
register-with-shield.py — Register the Pulse Shield callback Lambda with the ur/gd Shield service.

Called automatically by the CI/CD pipeline (deploy-pulse.yml) after every CloudFormation
deployment. Invokes the Shield registration Lambda via boto3 so that Shield's EventBridge
rule routes GuardDuty scan results to the correct Pulse callback Lambda for this environment.

This script must never be run manually — it is always invoked by the pipeline.

Environment variables (set by the workflow):
    CALLBACK_ARN             — ARN of urgd-pulse-shieldCallback-{env} (from CF output)
    SHIELD_REGISTRATION_ARN  — ARN of urgd-shield-registration-{env} (from SSM)
    APP_NAME                 — "pulse"
    AWS_REGION               — "us-west-2"

Requirements: 4.2, 5.3
"""

import json
import os
import sys

import boto3


def main() -> None:
    callback_arn = os.environ.get("CALLBACK_ARN", "").strip()
    shield_registration_arn = os.environ.get("SHIELD_REGISTRATION_ARN", "").strip()
    app_name = os.environ.get("APP_NAME", "pulse").strip()
    region = os.environ.get("AWS_REGION", "us-west-2").strip()

    if not callback_arn:
        print("❌ CALLBACK_ARN environment variable is not set", file=sys.stderr)
        sys.exit(1)

    if not shield_registration_arn:
        print("❌ SHIELD_REGISTRATION_ARN environment variable is not set", file=sys.stderr)
        sys.exit(1)

    payload = {
        "action": "register",
        "app_name": app_name,
        "callback_lambda_arn": callback_arn,
    }

    print(f"🔗 Registering {app_name} with Shield...", file=sys.stderr)
    print(f"   Callback ARN:  {callback_arn}", file=sys.stderr)
    print(f"   Shield Lambda: {shield_registration_arn}", file=sys.stderr)

    lambda_client = boto3.client("lambda", region_name=region)

    try:
        response = lambda_client.invoke(
            FunctionName=shield_registration_arn,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload).encode("utf-8"),
        )
    except Exception as e:
        print(f"❌ Failed to invoke Shield registration Lambda: {e}", file=sys.stderr)
        sys.exit(1)

    raw = response["Payload"].read()
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        print(f"❌ Shield registration returned non-JSON response: {raw!r}", file=sys.stderr)
        sys.exit(1)

    # Shield registration Lambda returns { body: { registration_successful: true } }
    body = result.get("body", {})
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            body = {}

    if body.get("registration_successful"):
        print("✅ Shield registration successful", file=sys.stderr)
        sys.exit(0)
    else:
        print(f"❌ Shield registration failed: {json.dumps(result)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
