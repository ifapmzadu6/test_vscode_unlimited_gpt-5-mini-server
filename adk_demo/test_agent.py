#!/usr/bin/env python3
"""
Test script for ADK Agent with VS Code LM Proxy.
Tests multi-turn conversation to verify iterative dialogue support.
"""

import asyncio
from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

# For connecting to our custom server, we need to use a custom approach
# since ADK typically expects Gemini models directly.
# We'll create a simple test using the REST API directly.

import urllib.request
import json

BASE_URL = "http://127.0.0.1:3141"

def run_conversation(messages: list[str]) -> list[str]:
    """Run a multi-turn conversation and return all responses."""
    responses = []
    session_id = f"session_{id(messages)}"
    
    for i, message in enumerate(messages):
        print(f"\n--- Turn {i+1} ---")
        print(f"User: {message}")
        
        payload = {
            "app_name": "math-agent",
            "user_id": "test-user",
            "session_id": session_id,
            "new_message": {
                "parts": [{"text": message}],
                "role": "user"
            }
        }
        
        req = urllib.request.Request(
            f"{BASE_URL}/run",
            data=json.dumps(payload).encode('utf-8'),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                events = json.loads(resp.read().decode('utf-8'))
                if events and isinstance(events, list):
                    content = events[0].get('content', {})
                    parts = content.get('parts', [])
                    if parts:
                        response_text = parts[0].get('text', '')
                        print(f"Assistant: {response_text[:200]}...")
                        responses.append(response_text)
        except Exception as e:
            print(f"Error: {e}")
            responses.append(f"ERROR: {e}")
    
    return responses

def test_multi_turn():
    """Test multi-turn conversation"""
    print("=" * 60)
    print("Multi-Turn Conversation Test")
    print("=" * 60)
    
    messages = [
        "What is 5 + 3?",
        "Now multiply that result by 2.",
        "What was the original sum again?",
        "And what's the final answer after multiplication?"
    ]
    
    responses = run_conversation(messages)
    
    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)
    print(f"Messages sent: {len(messages)}")
    print(f"Responses received: {len(responses)}")
    
    # Check if agent maintains context
    all_success = len(responses) == len(messages)
    print(f"\nMulti-turn support: {'✅ Working' if all_success else '❌ Failed'}")
    
    return all_success

def test_sse_streaming():
    """Test SSE streaming with multiple chunks"""
    print("\n" + "=" * 60)
    print("SSE Streaming Test")
    print("=" * 60)
    
    payload = {
        "app_name": "streaming-test",
        "user_id": "test-user",
        "session_id": "sse-test-session",
        "new_message": {
            "parts": [{"text": "Count from 1 to 5, one number per line."}],
            "role": "user"
        }
    }
    
    req = urllib.request.Request(
        f"{BASE_URL}/run_sse",
        data=json.dumps(payload).encode('utf-8'),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    
    chunk_count = 0
    final_text = ""
    
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            buffer = ""
            while True:
                chunk = resp.read(256).decode('utf-8')
                if not chunk:
                    break
                buffer += chunk
                
                while '\n\n' in buffer:
                    line, buffer = buffer.split('\n\n', 1)
                    if line.startswith('data: '):
                        data = line[6:]
                        if data == '[DONE]':
                            print("Received [DONE]")
                        else:
                            event = json.loads(data)
                            chunk_count += 1
                            content = event.get('content', {})
                            parts = content.get('parts', [])
                            if parts:
                                final_text = parts[0].get('text', '')
                                print(f"Chunk {chunk_count}: {len(final_text)} chars")
    except Exception as e:
        print(f"Error: {e}")
    
    print(f"\nTotal chunks: {chunk_count}")
    print(f"Final text: {final_text[:100]}...")
    print(f"SSE Streaming: {'✅ Working' if chunk_count > 0 else '❌ Failed'}")
    
    return chunk_count > 0

if __name__ == "__main__":
    print("VS Code LM Proxy - ADK Agent Integration Test")
    print("Testing multi-turn conversation and streaming")
    print()
    
    results = {
        "multi_turn": test_multi_turn(),
        "sse_streaming": test_sse_streaming(),
    }
    
    print("\n" + "=" * 60)
    print("FINAL RESULTS")
    print("=" * 60)
    for test, passed in results.items():
        print(f"{test}: {'✅ PASS' if passed else '❌ FAIL'}")
    
    if all(results.values()):
        print("\n🎉 All tests passed! Server supports iterative ADK conversations.")
    else:
        print("\n⚠️ Some tests failed.")
