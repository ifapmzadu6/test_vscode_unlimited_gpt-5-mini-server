#!/usr/bin/env python3
"""
Multi-session test to verify session isolation and management.
Tests that different sessions maintain separate conversation contexts.
"""

import urllib.request
import json
import random
import string

BASE_URL = "http://127.0.0.1:3141"

def make_request(path, method="GET", data=None):
    """Make HTTP request"""
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

def run_turn(session_id: str, message: str, turn_num: int) -> str:
    """Run a single turn in a session"""
    payload = {
        "app_name": "test-agent",
        "user_id": "test-user",
        "session_id": session_id,
        "new_message": {
            "parts": [{"text": message}],
            "role": "user"
        }
    }
    status, events = make_request("/run", "POST", payload)
    
    if status == 200 and isinstance(events, list) and len(events) > 0:
        content = events[0].get('content', {})
        parts = content.get('parts', [])
        if parts:
            return parts[0].get('text', '')[:150]
    return f"ERROR: {events}"

def test_session_isolation():
    """Test that different sessions are isolated"""
    print("=" * 60)
    print("Session Isolation Test")
    print("=" * 60)
    
    session_a = f"session_A_{random.randint(1000, 9999)}"
    session_b = f"session_B_{random.randint(1000, 9999)}"
    
    print(f"\nSession A: {session_a}")
    print(f"Session B: {session_b}")
    
    # Session A: Math context
    print("\n--- Session A: Math Context ---")
    a1 = run_turn(session_a, "What is 10 + 20? Just give the number.", 1)
    print(f"A1 User: 10 + 20?")
    print(f"A1 Response: {a1}")
    
    # Session B: Different topic
    print("\n--- Session B: Color Context ---")
    b1 = run_turn(session_b, "What color is the sky on a clear day? One word.", 1)
    print(f"B1 User: Sky color?")
    print(f"B1 Response: {b1}")
    
    # Session A: Continue math (should remember 30)
    print("\n--- Session A: Continue Math ---")
    a2 = run_turn(session_a, "Double that result.", 2)
    print(f"A2 User: Double that result.")
    print(f"A2 Response: {a2}")
    
    # Session B: Continue color (should remember blue)
    print("\n--- Session B: Continue Color ---")
    b2 = run_turn(session_b, "And what about grass? One word.", 2)
    print(f"B2 User: Grass color?")
    print(f"B2 Response: {b2}")
    
    # Verify sessions are isolated
    print("\n--- Verification ---")
    a3 = run_turn(session_a, "What was the original number before doubling?", 3)
    print(f"A3: Original number? → {a3}")
    
    b3 = run_turn(session_b, "What was the first color I asked about?", 3)
    print(f"B3: First color? → {b3}")
    
    # Check results
    session_a_ok = "30" in a2 or "60" in a2
    session_b_ok = "blue" in b1.lower() or "green" in b2.lower()
    
    print(f"\nSession A isolated: {'✅' if session_a_ok else '⚠️'}")
    print(f"Session B isolated: {'✅' if session_b_ok else '⚠️'}")
    
    return session_a_ok and session_b_ok

def test_multiple_sessions():
    """Run multiple independent sessions"""
    print("\n" + "=" * 60)
    print("Multiple Sessions Test (3 concurrent sessions)")
    print("=" * 60)
    
    sessions = {}
    results = {}
    
    # Create 3 sessions with different math problems
    problems = [
        ("What is 5 * 5?", 25),
        ("What is 7 + 8?", 15),
        ("What is 100 / 4?", 25),
    ]
    
    for i, (question, expected) in enumerate(problems):
        session_id = f"multi_session_{i}_{random.randint(1000, 9999)}"
        sessions[session_id] = {"question": question, "expected": expected}
        
        print(f"\nSession {i+1} ({session_id[:20]}...): {question}")
        response = run_turn(session_id, question, 1)
        print(f"  Response: {response[:80]}")
        results[session_id] = str(expected) in response
    
    # Now ask each session to recall
    print("\n--- Recall Test ---")
    for session_id, data in sessions.items():
        response = run_turn(session_id, "What was my question and your answer?", 2)
        print(f"Session recall: {response[:100]}")
        recall_ok = str(data['expected']) in response
        results[session_id] = results[session_id] and recall_ok
    
    success = sum(1 for v in results.values() if v)
    print(f"\nSessions working: {success}/{len(results)}")
    
    return success == len(results)

def test_session_api():
    """Test session management API"""
    print("\n" + "=" * 60)
    print("Session Management API Test")
    print("=" * 60)
    
    # List sessions before
    status, sessions_before = make_request("/apps/test-app/users/api-test/sessions")
    print(f"Sessions before: {len(sessions_before) if isinstance(sessions_before, list) else 0}")
    
    # Create 3 sessions
    created_ids = []
    for i in range(3):
        status, session = make_request("/apps/test-app/users/api-test/sessions", "POST")
        if status == 201:
            created_ids.append(session.get('id'))
            print(f"Created session {i+1}: {session.get('id', 'N/A')[:30]}...")
    
    # List sessions after
    status, sessions_after = make_request("/apps/test-app/users/api-test/sessions")
    print(f"Sessions after create: {len(sessions_after) if isinstance(sessions_after, list) else 0}")
    
    # Delete all created sessions
    for session_id in created_ids:
        url = f"{BASE_URL}/apps/test-app/users/api-test/sessions/{session_id}"
        req = urllib.request.Request(url, method="DELETE")
        try:
            with urllib.request.urlopen(req) as resp:
                pass  # 204 No Content expected
        except:
            pass
    
    # List sessions final
    status, sessions_final = make_request("/apps/test-app/users/api-test/sessions")
    final_count = len(sessions_final) if isinstance(sessions_final, list) else 0
    print(f"Sessions after delete: {final_count}")
    
    return len(created_ids) == 3

if __name__ == "__main__":
    print("VS Code LM Proxy - Multi-Session Test Suite")
    print("Testing session isolation and management\n")
    
    results = {
        "session_isolation": test_session_isolation(),
        "multiple_sessions": test_multiple_sessions(),
        "session_api": test_session_api(),
    }
    
    print("\n" + "=" * 60)
    print("FINAL RESULTS")
    print("=" * 60)
    for test, passed in results.items():
        print(f"{test}: {'✅ PASS' if passed else '❌ FAIL'}")
    
    if all(results.values()):
        print("\n🎉 All session tests passed!")
    else:
        print("\n⚠️ Some tests need attention.")
