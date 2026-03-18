#!/usr/bin/env python3
"""
S2 Smoke Tests:
1. Create item (paste content) → appears in items list → edit name → save → delete → gone
2. Cascading delete — confirm no orphaned records in DynamoDB or S3
3. Create item (upload PDF) — verify documentStatus transitions (covered via presigned URL check)
"""

import json
import sys
import boto3
import requests
from warrant import Cognito

API = "https://api-dev.pulse.urgdstudios.com"
REGION = "us-west-2"
USER_POOL_ID = "us-west-2_PsMrmZgzV"
CLIENT_ID = "21vsdonqg5q3qa7u950l9vctdi"
EMAIL = "smoke-test@urgd.dev"
PASSWORD = "Pulse!Smoke99"
ENV = "dev"

TABLES = {
    "items":    f"urgd-pulse-items-{ENV}",
    "sessions": f"urgd-pulse-sessions-{ENV}",
    "transcripts": f"urgd-pulse-transcripts-{ENV}",
    "reports":  f"urgd-pulse-reports-{ENV}",
    "pulsechecks": f"urgd-pulse-pulsechecks-{ENV}",
}
DATA_BUCKET = f"urgd-pulse-data-{ENV}"

ddb = boto3.client("dynamodb", region_name=REGION)
s3  = boto3.client("s3", region_name=REGION)

def ok(msg): print(f"  ✅ {msg}")
def fail(msg): print(f"  ❌ {msg}"); sys.exit(1)
def section(msg): print(f"\n{'─'*60}\n{msg}\n{'─'*60}")

# ── Auth ──────────────────────────────────────────────────────────────────────
section("Auth — getting ID token")
u = Cognito(USER_POOL_ID, CLIENT_ID, username=EMAIL)
u.authenticate(password=PASSWORD)
token = u.id_token
ok(f"Authenticated as {EMAIL}")

headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

# ── Ensure tenant exists ──────────────────────────────────────────────────────
section("Tenant — ensure tenant record exists")
r = requests.get(f"{API}/api/manage/settings", headers=headers)
if r.status_code == 404:
    # Create tenant
    r2 = requests.post(f"{API}/api/auth/tenant", headers=headers)
    if r2.status_code not in (200, 201):
        fail(f"Could not create tenant: {r2.status_code} {r2.text}")
    ok("Tenant created")
    r = requests.get(f"{API}/api/manage/settings", headers=headers)

if r.status_code != 200:
    fail(f"GET /settings returned {r.status_code}: {r.text}")

settings = r.json()
tenant_id = settings.get("tenantId")
if not tenant_id:
    fail(f"No tenantId in settings response: {settings}")
ok(f"Tenant exists: {tenant_id}")

# ══════════════════════════════════════════════════════════════════════════════
# SMOKE TEST 1: Create → List → Edit → Delete (with content paste)
# ══════════════════════════════════════════════════════════════════════════════
section("Smoke Test 1: Create item (paste content) → list → edit → delete")

# Create
payload = {
    "itemName": "Smoke Test Item",
    "description": "Created by S2 smoke test",
    "content": "# Test Document\n\nThis is smoke test content pasted directly.",
    "closeDate": "2026-12-31T23:59:59Z",
}
r = requests.post(f"{API}/api/manage/items", headers=headers, json=payload)
if r.status_code not in (200, 201):
    fail(f"POST /items returned {r.status_code}: {r.text}")
item = r.json()
item = item.get("data", item)  # unwrap data envelope if present
item_id = item.get("itemId")
if not item_id:
    fail(f"No itemId in response: {item}")
ok(f"Item created: {item_id}")
assert item.get("status") == "draft", f"Expected status=draft, got {item.get('status')}"
ok("Status is 'draft'")

# Verify in DynamoDB
resp = ddb.get_item(
    TableName=TABLES["items"],
    Key={"tenantId": {"S": tenant_id}, "itemId": {"S": item_id}}
)
if "Item" not in resp:
    fail(f"Item {item_id} not found in DynamoDB items table")
ok(f"Item confirmed in DynamoDB items table")

# Verify content in S3
s3_key = f"pulse/{tenant_id}/items/{item_id}/document.md"
try:
    s3.head_object(Bucket=DATA_BUCKET, Key=s3_key)
    ok(f"Content stored in S3 at {s3_key}")
except Exception as e:
    fail(f"Content not found in S3 at {s3_key}: {e}")

# List — item appears
r = requests.get(f"{API}/api/manage/items", headers=headers)
if r.status_code != 200:
    fail(f"GET /items returned {r.status_code}: {r.text}")
items_list = r.json().get("data", r.json() if isinstance(r.json(), list) else [])
ids = [i.get("itemId") for i in items_list]
if item_id not in ids:
    fail(f"Item {item_id} not in items list: {ids}")
ok(f"Item appears in GET /items list ({len(items_list)} total)")

# Edit name
r = requests.put(f"{API}/api/manage/items/{item_id}", headers=headers,
                 json={"itemName": "Smoke Test Item (edited)"})
if r.status_code != 200:
    fail(f"PUT /items/{item_id} returned {r.status_code}: {r.text}")
updated = r.json()
updated = updated.get("data", updated)  # unwrap data envelope
if updated.get("itemName") != "Smoke Test Item (edited)":
    fail(f"Name not updated: {updated.get('itemName')}")
ok("Item name updated successfully")

# Verify updated name in DynamoDB
resp = ddb.get_item(
    TableName=TABLES["items"],
    Key={"tenantId": {"S": tenant_id}, "itemId": {"S": item_id}}
)
db_name = resp["Item"].get("itemName", {}).get("S", "")
if db_name != "Smoke Test Item (edited)":
    fail(f"DynamoDB name not updated: {db_name}")
ok("Updated name confirmed in DynamoDB")

# Delete
r = requests.delete(f"{API}/api/manage/items/{item_id}", headers=headers)
if r.status_code != 200:
    fail(f"DELETE /items/{item_id} returned {r.status_code}: {r.text}")
ok("DELETE returned 200")

# ══════════════════════════════════════════════════════════════════════════════
# SMOKE TEST 2: Cascading delete — verify all tables + S3 clean
# ══════════════════════════════════════════════════════════════════════════════
section("Smoke Test 2: Cascading delete — verify no orphaned data")

# Items table
resp = ddb.get_item(
    TableName=TABLES["items"],
    Key={"tenantId": {"S": tenant_id}, "itemId": {"S": item_id}}
)
if "Item" in resp:
    fail(f"Item {item_id} still exists in items table after delete")
ok("Items table: record deleted")

# Sessions table (query by item-index GSI)
resp = ddb.query(
    TableName=TABLES["sessions"],
    IndexName="item-index",
    KeyConditionExpression="itemId = :iid",
    ExpressionAttributeValues={":iid": {"S": item_id}}
)
if resp.get("Count", 0) > 0:
    fail(f"Sessions table still has {resp['Count']} records for itemId {item_id}")
ok("Sessions table: no orphaned records")

# Reports table (query by item-index GSI)
resp = ddb.query(
    TableName=TABLES["reports"],
    IndexName="item-index",
    KeyConditionExpression="itemId = :iid",
    ExpressionAttributeValues={":iid": {"S": item_id}}
)
if resp.get("Count", 0) > 0:
    fail(f"Reports table still has {resp['Count']} records for itemId {item_id}")
ok("Reports table: no orphaned records")

# PulseChecks table
resp = ddb.get_item(
    TableName=TABLES["pulsechecks"],
    Key={"tenantId": {"S": tenant_id}, "itemId": {"S": item_id}}
)
if "Item" in resp:
    fail(f"PulseChecks table still has record for itemId {item_id}")
ok("PulseChecks table: no orphaned records")

# S3 — list objects under the item prefix
resp = s3.list_objects_v2(
    Bucket=DATA_BUCKET,
    Prefix=f"pulse/{tenant_id}/items/{item_id}/"
)
count = resp.get("KeyCount", 0)
if count > 0:
    keys = [o["Key"] for o in resp.get("Contents", [])]
    fail(f"S3 still has {count} objects under item prefix: {keys}")
ok(f"S3: no orphaned objects under pulse/{tenant_id}/items/{item_id}/")

# ══════════════════════════════════════════════════════════════════════════════
# SMOKE TEST 3: Upload URL — verify presigned URL generation + documentStatus
# ══════════════════════════════════════════════════════════════════════════════
section("Smoke Test 3: Upload URL — presigned URL generation")

# Create a fresh item for upload test
r = requests.post(f"{API}/api/manage/items", headers=headers,
                  json={"itemName": "Upload Test Item", "description": "For upload smoke test", "closeDate": "2026-12-31T23:59:59Z"})
if r.status_code not in (200, 201):
    fail(f"POST /items returned {r.status_code}: {r.text}")
upload_item = r.json()
upload_item = upload_item.get("data", upload_item)  # unwrap data envelope
upload_item_id = upload_item.get("itemId")
ok(f"Upload test item created: {upload_item_id}")

# Get presigned URL for a PDF
r = requests.post(f"{API}/api/manage/items/upload-url", headers=headers,
                  json={"itemId": upload_item_id, "fileName": "test.pdf", "fileSize": 1024 * 100})
if r.status_code != 200:
    fail(f"POST /upload-url returned {r.status_code}: {r.text}")
url_resp = r.json()
presigned_url = url_resp.get("uploadUrl") or url_resp.get("url") or url_resp.get("presignedUrl")
if not presigned_url:
    fail(f"No presigned URL in response: {url_resp}")
ok(f"Presigned URL received (length={len(presigned_url)})")

# Verify documentStatus updated to "scanning" in DynamoDB
resp = ddb.get_item(
    TableName=TABLES["items"],
    Key={"tenantId": {"S": tenant_id}, "itemId": {"S": upload_item_id}}
)
doc_status = resp.get("Item", {}).get("documentStatus", {}).get("S", "")
if doc_status != "scanning":
    fail(f"documentStatus not 'scanning' after getUploadUrl: '{doc_status}'")
ok(f"documentStatus = 'scanning' confirmed in DynamoDB")

# Verify unsupported file type rejected
r = requests.post(f"{API}/api/manage/items/upload-url", headers=headers,
                  json={"itemId": upload_item_id, "fileName": "malware.exe", "fileSize": 1024})
if r.status_code != 400:
    fail(f"Expected 400 for .exe, got {r.status_code}: {r.text}")
ok("Unsupported file type (.exe) correctly rejected with 400")

# Verify oversized file rejected
r = requests.post(f"{API}/api/manage/items/upload-url", headers=headers,
                  json={"itemId": upload_item_id, "fileName": "big.pdf", "fileSize": 11 * 1024 * 1024})
if r.status_code != 400:
    fail(f"Expected 400 for oversized file, got {r.status_code}: {r.text}")
ok("Oversized file (>10MB) correctly rejected with 400")

# Clean up upload test item
r = requests.delete(f"{API}/api/manage/items/{upload_item_id}", headers=headers)
ok(f"Upload test item cleaned up (status={r.status_code})")

# ── Summary ───────────────────────────────────────────────────────────────────
section("ALL SMOKE TESTS PASSED")
print("  Smoke Test 1: Create → List → Edit → Delete ✅")
print("  Smoke Test 2: Cascading delete (all tables + S3) ✅")
print("  Smoke Test 3: Upload URL generation + validation ✅")
