#!/usr/bin/env python3
"""Thread isolation test for OpenAI Assistants API."""

import urllib.request
import json

BASE_URL = "http://127.0.0.1:3141"

def req(path, method="GET", data=None):
    url = f"{BASE_URL}{path}"
    headers = {"Content-Type": "application/json"}
    req_data = json.dumps(data).encode('utf-8') if data else None
    r = urllib.request.Request(url, data=req_data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.loads(resp.read().decode('utf-8'))

print("=== Thread Isolation Test ===\n")

# Thread A: Math context
t1 = req("/v1/threads", "POST", {})
print(f"Thread A: {t1['id'][:25]}...")
req(f"/v1/threads/{t1['id']}/messages", "POST", {"role": "user", "content": "What is 100 + 50?"})
req(f"/v1/threads/{t1['id']}/runs", "POST", {"assistant_id": "asst_default"})
msgs1 = req(f"/v1/threads/{t1['id']}/messages")
print(f"A1: 100+50 -> {msgs1['data'][-1]['content'][0]['text']['value'][:50]}")

# Thread B: Color context
t2 = req("/v1/threads", "POST", {})
print(f"Thread B: {t2['id'][:25]}...")
req(f"/v1/threads/{t2['id']}/messages", "POST", {"role": "user", "content": "What color is snow?"})
req(f"/v1/threads/{t2['id']}/runs", "POST", {"assistant_id": "asst_default"})
msgs2 = req(f"/v1/threads/{t2['id']}/messages")
print(f"B1: Snow -> {msgs2['data'][-1]['content'][0]['text']['value'][:50]}")

# Thread A continue (should remember 150)
req(f"/v1/threads/{t1['id']}/messages", "POST", {"role": "user", "content": "Double it"})
req(f"/v1/threads/{t1['id']}/runs", "POST", {"assistant_id": "asst_default"})
msgs1 = req(f"/v1/threads/{t1['id']}/messages")
print(f"A2: Double -> {msgs1['data'][-1]['content'][0]['text']['value'][:50]}")

# Thread B continue (should NOT know math)
req(f"/v1/threads/{t2['id']}/messages", "POST", {"role": "user", "content": "And grass?"})
req(f"/v1/threads/{t2['id']}/runs", "POST", {"assistant_id": "asst_default"})
msgs2 = req(f"/v1/threads/{t2['id']}/messages")
print(f"B2: Grass -> {msgs2['data'][-1]['content'][0]['text']['value'][:50]}")

# Verify isolation
a2_text = msgs1['data'][-1]['content'][0]['text']['value'].lower()
b2_text = msgs2['data'][-1]['content'][0]['text']['value'].lower()

a_ok = "300" in a2_text or "three hundred" in a2_text
b_ok = "green" in b2_text

print(f"\n=== Results ===")
print(f"Thread A remembers 150 and doubled: {'✅' if a_ok else '⚠️'}")
print(f"Thread B stays in color context: {'✅' if b_ok else '⚠️'}")
print(f"\n{'✅ Threads are isolated!' if a_ok and b_ok else '⚠️ Check responses above'}")
