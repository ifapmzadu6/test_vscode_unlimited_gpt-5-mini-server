#!/usr/bin/env python3
"""
Test script for VS Code LM Proxy Server with Google ADK API format.
Uses only Python standard library (no external dependencies).
"""

import urllib.request
import urllib.error
import json

BASE_URL = "http://127.0.0.1:3141"

def make_request(path, method="GET", data=None):
    """Make HTTP request and return (status_code, response_data)"""
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

def test_health():
    print("=== Testing /health ===")
    status, data = make_request("/health")
    print(f"Status: {status}, Response: {data}")
    return status == 200

def test_list_apps():
    print("\n=== Testing /list-apps ===")
    status, data = make_request("/list-apps")
    print(f"Status: {status}, Apps: {data}")
    return status == 200 and isinstance(data, list)

def test_run():
    print("\n=== Testing /run (ADK) ===")
    payload = {
        "app_name": "vscode-lm-proxy",
        "user_id": "python-test-user",
        "session_id": "python-test-session",
        "new_message": {
            "parts": [{"text": "What is 2+2? Answer with just the number."}],
            "role": "user"
        }
    }
    status, events = make_request("/run", "POST", payload)
    print(f"Status: {status}")
    
    if status == 200 and isinstance(events, list) and len(events) > 0:
        event = events[0]
        print(f"Event ID: {event.get('id')}")
        print(f"Invocation ID: {event.get('invocation_id')}")
        print(f"Author: {event.get('author')}")
        content = event.get('content', {})
        parts = content.get('parts', [])
        if parts:
            print(f"Response: {parts[0].get('text', '')[:200]}")
        return True
    else:
        print(f"Error: {events}")
        return False

def test_sessions():
    print("\n=== Testing Session Management ===")
    
    # Create session
    status, session = make_request("/apps/test-app/users/py-user/sessions", "POST")
    print(f"Create: {status}, ID: {session.get('id', 'N/A')}")
    
    if status != 201:
        return False
    
    session_id = session.get('id')
    
    # List sessions
    status, sessions = make_request("/apps/test-app/users/py-user/sessions")
    print(f"List: {status}, Count: {len(sessions) if isinstance(sessions, list) else 0}")
    
    # Get session
    status, _ = make_request(f"/apps/test-app/users/py-user/sessions/{session_id}")
    print(f"Get: {status}")
    
    # Delete - need to handle 204 specially
    url = f"{BASE_URL}/apps/test-app/users/py-user/sessions/{session_id}"
    req = urllib.request.Request(url, method="DELETE")
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"Delete: {resp.status}")
            return True
    except urllib.error.HTTPError as e:
        print(f"Delete: {e.code}")
        return e.code == 204

if __name__ == "__main__":
    print("=" * 50)
    print("VS Code LM Proxy - ADK Compatibility Test")
    print("=" * 50)
    
    results = {
        "health": test_health(),
        "list_apps": test_list_apps(),
        "run": test_run(),
        "sessions": test_sessions(),
    }
    
    print("\n" + "=" * 50)
    print("RESULTS SUMMARY")
    print("=" * 50)
    for name, passed in results.items():
        print(f"{name}: {'✅ PASS' if passed else '❌ FAIL'}")
    
    print(f"\n{'✅ ALL TESTS PASSED' if all(results.values()) else '❌ SOME TESTS FAILED'}")
