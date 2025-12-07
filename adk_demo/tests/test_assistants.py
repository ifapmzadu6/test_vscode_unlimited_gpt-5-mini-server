#!/usr/bin/env python3
"""
Test script for OpenAI Assistants API compatible endpoints.
"""

import urllib.request
import json

BASE_URL = "http://127.0.0.1:3141"

def make_request(path, method="GET", data=None):
    url = f"{BASE_URL}{path}"
    headers = {"Content-Type": "application/json"}
    req_data = json.dumps(data).encode('utf-8') if data else None
    req = urllib.request.Request(url, data=req_data, headers=headers, method=method)
    
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read().decode('utf-8')
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8')
        return e.code, json.loads(body) if body else {}
    except Exception as e:
        return 0, {"error": str(e)}

def test_assistants():
    print("=== Testing /v1/assistants ===")
    status, data = make_request("/v1/assistants")
    print(f"Status: {status}")
    print(f"Assistants: {len(data.get('data', []))}")
    return status == 200

def test_thread_lifecycle():
    print("\n=== Testing Thread Lifecycle ===")
    
    # Create thread
    status, thread = make_request("/v1/threads", "POST", {})
    print(f"Create thread: {status}")
    if status != 201:
        return False
    thread_id = thread.get('id')
    print(f"Thread ID: {thread_id}")
    
    # Get thread
    status, _ = make_request(f"/v1/threads/{thread_id}")
    print(f"Get thread: {status}")
    
    # Add message
    status, msg = make_request(f"/v1/threads/{thread_id}/messages", "POST", {
        "role": "user",
        "content": "What is 2+2?"
    })
    print(f"Add message: {status}, ID: {msg.get('id')}")
    
    # List messages
    status, msgs = make_request(f"/v1/threads/{thread_id}/messages")
    print(f"List messages: {status}, count: {len(msgs.get('data', []))}")
    
    # Create run
    print("\n--- Creating Run ---")
    status, run = make_request(f"/v1/threads/{thread_id}/runs", "POST", {
        "assistant_id": "asst_default"
    })
    print(f"Run status: {status}")
    print(f"Run ID: {run.get('id')}")
    print(f"Run status field: {run.get('status')}")
    
    # Check messages after run
    status, msgs_after = make_request(f"/v1/threads/{thread_id}/messages")
    print(f"Messages after run: {len(msgs_after.get('data', []))}")
    
    if len(msgs_after.get('data', [])) >= 2:
        response = msgs_after['data'][-1]['content'][0]['text']['value']
        print(f"Assistant response: {response[:100]}...")
    
    # Delete thread
    status, _ = make_request(f"/v1/threads/{thread_id}", "DELETE")
    print(f"Delete thread: {status}")
    
    return run.get('status') == 'completed'

def test_multiturn():
    print("\n=== Testing Multi-turn Conversation ===")
    
    # Create thread
    _, thread = make_request("/v1/threads", "POST", {})
    thread_id = thread['id']
    
    conversations = [
        "What is 10 + 5?",
        "Now multiply that by 2.",
        "What was the first number I asked about?"
    ]
    
    for i, msg in enumerate(conversations):
        print(f"\nTurn {i+1}: {msg}")
        make_request(f"/v1/threads/{thread_id}/messages", "POST", {
            "role": "user", "content": msg
        })
        _, run = make_request(f"/v1/threads/{thread_id}/runs", "POST", {
            "assistant_id": "asst_default"
        })
        _, msgs = make_request(f"/v1/threads/{thread_id}/messages")
        response = msgs['data'][-1]['content'][0]['text']['value']
        print(f"Response: {response[:80]}...")
    
    # Cleanup
    make_request(f"/v1/threads/{thread_id}", "DELETE")
    return True

if __name__ == "__main__":
    print("OpenAI Assistants API Test\n")
    
    results = {
        "assistants": test_assistants(),
        "thread_lifecycle": test_thread_lifecycle(),
        "multiturn": test_multiturn(),
    }
    
    print("\n" + "=" * 50)
    print("RESULTS")
    for test, passed in results.items():
        print(f"{test}: {'✅' if passed else '❌'}")
    print(f"\n{'🎉 All passed!' if all(results.values()) else '⚠️ Some failed'}")
