#!/usr/bin/env python3
"""
Complex ADK Agent Configuration Tests.
Tests advanced multi-agent patterns: Sequential, Parallel, Hierarchical, Agent-as-Tool, Loop.
"""

import urllib.request
import urllib.error
import json
import random
import time
import concurrent.futures
from typing import Optional

BASE_URL = "http://127.0.0.1:3141"

def make_request(path: str, method: str = "GET", data: dict = None, timeout: int = 120) -> tuple:
    """Make HTTP request and return (status_code, response_data)"""
    url = f"{BASE_URL}{path}"
    headers = {"Content-Type": "application/json"}
    req_data = json.dumps(data).encode('utf-8') if data else None
    req = urllib.request.Request(url, data=req_data, headers=headers, method=method)
    
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8')
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8')
        return e.code, json.loads(body) if body else {}
    except Exception as e:
        return 0, {"error": str(e)}

def run_turn(session_id: str, message: str, app_name: str = "complex-agent") -> str:
    """Run a single turn in a session and return response text"""
    payload = {
        "app_name": app_name,
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
            return parts[0].get('text', '')
    return f"ERROR: status={status}, response={events}"


# =============================================================================
# Pattern 1: Sequential Pipeline
# =============================================================================
def test_sequential_pipeline():
    """
    Test Sequential Agent Pipeline pattern.
    Simulates a 3-stage pipeline: Translate → Summarize → Format
    Each step uses the previous step's output as input.
    """
    print("=" * 70)
    print("Pattern 1: Sequential Pipeline")
    print("=" * 70)
    print("Description: 3-stage processing pipeline (Translate → Summarize → Format)")
    
    session_id = f"sequential_{random.randint(10000, 99999)}"
    
    # Stage 1: Translation agent
    print("\n--- Stage 1: Translation Agent ---")
    stage1_prompt = """You are a translation agent. 
Translate the following Japanese text to English:
「人工知能は現代社会において重要な役割を果たしています。機械学習やディープラーニングの進歩により、様々な分野で革新が起きています。」
Respond ONLY with the English translation, nothing else."""

    stage1_result = run_turn(session_id, stage1_prompt)
    print(f"Input: Japanese text about AI")
    print(f"Output: {stage1_result[:150]}...")
    
    # Stage 2: Summarization agent (uses stage 1 output)
    print("\n--- Stage 2: Summarization Agent ---")
    stage2_prompt = f"""You are a summarization agent.
Take this text and create a one-sentence summary:
---
{stage1_result}
---
Respond ONLY with the one-sentence summary, nothing else."""

    stage2_result = run_turn(session_id, stage2_prompt)
    print(f"Input: English translation from Stage 1")
    print(f"Output: {stage2_result[:150]}...")
    
    # Stage 3: Formatting agent (uses stage 2 output)
    print("\n--- Stage 3: Formatting Agent ---")
    stage3_prompt = f"""You are a formatting agent.
Take this summary and format it as a bullet point with emoji:
---
{stage2_result}
---
Format: • 🤖 [summary text]
Respond ONLY with the formatted bullet point, nothing else."""

    stage3_result = run_turn(session_id, stage3_prompt)
    print(f"Input: Summary from Stage 2")
    print(f"Output: {stage3_result[:150]}...")
    
    # Validate pipeline
    print("\n--- Validation ---")
    all_stages_ok = (
        "ERROR" not in stage1_result and
        "ERROR" not in stage2_result and
        "ERROR" not in stage3_result and
        len(stage1_result) > 10 and
        len(stage2_result) > 10 and
        len(stage3_result) > 5
    )
    
    print(f"Stage 1 (Translation): {'✅' if 'ERROR' not in stage1_result else '❌'}")
    print(f"Stage 2 (Summarization): {'✅' if 'ERROR' not in stage2_result else '❌'}")
    print(f"Stage 3 (Formatting): {'✅' if 'ERROR' not in stage3_result else '❌'}")
    print(f"Pipeline Complete: {'✅ PASS' if all_stages_ok else '❌ FAIL'}")
    
    return all_stages_ok


# =============================================================================
# Pattern 2: Parallel Fan-out/Gather
# =============================================================================
def test_parallel_fanout():
    """
    Test Parallel Fan-out/Gather pattern.
    Sends same query to multiple agents in parallel, then gathers results.
    """
    print("\n" + "=" * 70)
    print("Pattern 2: Parallel Fan-out/Gather")
    print("=" * 70)
    print("Description: Same query to 3 parallel agents, gather and compare results")
    
    query = "What are the three primary colors? List them as comma-separated values only."
    
    # Create 3 different sessions (simulating 3 parallel agents)
    sessions = [
        {"id": f"parallel_analyst_{random.randint(10000, 99999)}", "role": "Analyst"},
        {"id": f"parallel_scientist_{random.randint(10000, 99999)}", "role": "Scientist"},
        {"id": f"parallel_artist_{random.randint(10000, 99999)}", "role": "Artist"},
    ]
    
    print(f"\nQuery: {query}")
    print("\n--- Parallel Execution ---")
    
    results = []
    start_time = time.time()
    
    # Execute in parallel using ThreadPoolExecutor
    def execute_agent(session_info):
        prompt = f"You are a {session_info['role']}. {query}"
        response = run_turn(session_info['id'], prompt)
        return {"role": session_info['role'], "response": response}
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        future_to_session = {executor.submit(execute_agent, s): s for s in sessions}
        for future in concurrent.futures.as_completed(future_to_session):
            result = future.result()
            results.append(result)
            print(f"  {result['role']}: {result['response'][:80]}...")
    
    elapsed_time = time.time() - start_time
    print(f"\nParallel execution time: {elapsed_time:.2f}s")
    
    # Gather and analyze results
    print("\n--- Gather & Analysis ---")
    all_responses = [r['response'] for r in results]
    
    # Check if all responses mention primary colors
    color_keywords = ['red', 'blue', 'yellow', 'green', 'cyan', 'magenta']
    valid_responses = 0
    for resp in all_responses:
        if any(color.lower() in resp.lower() for color in color_keywords):
            valid_responses += 1
    
    success = valid_responses >= 2 and len(results) == 3
    
    print(f"Responses collected: {len(results)}/3")
    print(f"Valid color responses: {valid_responses}/3")
    print(f"Parallel Fan-out/Gather: {'✅ PASS' if success else '❌ FAIL'}")
    
    return success


# =============================================================================
# Pattern 3: Hierarchical Coordinator
# =============================================================================
def test_hierarchical_coordinator():
    """
    Test Hierarchical Coordinator pattern.
    Coordinator analyzes request, delegates to appropriate sub-agent.
    """
    print("\n" + "=" * 70)
    print("Pattern 3: Hierarchical Coordinator")
    print("=" * 70)
    print("Description: Coordinator agent delegates to specialized sub-agents")
    
    coordinator_session = f"coordinator_{random.randint(10000, 99999)}"
    
    # Test cases for different sub-agents
    test_cases = [
        {
            "type": "Math",
            "query": "Calculate 15 * 7 + 23",
            "expected_keywords": ["128", "one hundred twenty-eight"]
        },
        {
            "type": "Language",
            "query": "What is the past tense of 'run'?",
            "expected_keywords": ["ran"]
        },
        {
            "type": "General",
            "query": "What planet is known as the Red Planet?",
            "expected_keywords": ["mars"]
        }
    ]
    
    results = {}
    
    for tc in test_cases:
        print(f"\n--- {tc['type']} Sub-agent Test ---")
        
        # Coordinator prompt
        coordinator_prompt = f"""You are a coordinator agent that delegates tasks to specialized sub-agents.

Analyze this user request and respond as the appropriate specialist:
- For math problems → respond as Math Agent
- For language/grammar → respond as Language Agent  
- For general knowledge → respond as General Agent

User Request: {tc['query']}

First identify which agent should handle this (Math/Language/General), then provide the answer.
Format: [AGENT_TYPE]: answer"""

        session = f"{coordinator_session}_{tc['type'].lower()}"
        response = run_turn(session, coordinator_prompt)
        
        print(f"Query: {tc['query']}")
        print(f"Response: {response[:120]}...")
        
        # Validate response contains expected content
        is_valid = any(kw.lower() in response.lower() for kw in tc['expected_keywords'])
        results[tc['type']] = is_valid
        print(f"Expected keywords found: {'✅' if is_valid else '❌'}")
    
    print("\n--- Summary ---")
    all_passed = all(results.values())
    for agent_type, passed in results.items():
        print(f"{agent_type} delegation: {'✅' if passed else '❌'}")
    print(f"Hierarchical Coordinator: {'✅ PASS' if all_passed else '❌ FAIL'}")
    
    return all_passed


# =============================================================================
# Pattern 4: Agent-as-Tool
# =============================================================================
def test_agent_as_tool():
    """
    Test Agent-as-Tool pattern.
    Main agent explicitly invokes specialized agents as tools.
    """
    print("\n" + "=" * 70)
    print("Pattern 4: Agent-as-Tool")
    print("=" * 70)
    print("Description: Main agent uses sub-agents as function calls")
    
    # Simulate tool-like agent calls
    session_base = f"agent_tool_{random.randint(10000, 99999)}"
    
    # Step 1: Call "data retrieval" agent
    print("\n--- Tool Call 1: Data Retrieval Agent ---")
    data_agent_prompt = """You are a data retrieval agent (tool).
Return EXACTLY this JSON with no other text:
{"temperature": 25, "humidity": 60, "city": "Tokyo"}"""
    
    data_result = run_turn(f"{session_base}_data", data_agent_prompt)
    print(f"Data Agent Response: {data_result[:100]}")
    
    # Step 2: Call "analysis" agent with data
    print("\n--- Tool Call 2: Analysis Agent ---")
    analysis_prompt = f"""You are an analysis agent (tool).
Analyze this weather data and return a comfort level (1-10):
{data_result}
Respond with ONLY a number from 1-10."""
    
    analysis_result = run_turn(f"{session_base}_analysis", analysis_prompt)
    print(f"Analysis Agent Response: {analysis_result[:50]}")
    
    # Step 3: Main agent combines results
    print("\n--- Main Agent: Combining Tool Results ---")
    main_prompt = f"""You are the main orchestrator agent.
You have received results from two tool agents:

Data Agent returned: {data_result}
Analysis Agent returned: Comfort level {analysis_result}

Generate a brief weather report based on this information.
Keep it to 2 sentences maximum."""
    
    final_result = run_turn(f"{session_base}_main", main_prompt)
    print(f"Final Report: {final_result[:200]}")
    
    # Validate
    print("\n--- Validation ---")
    success = (
        "ERROR" not in data_result and
        "ERROR" not in analysis_result and
        "ERROR" not in final_result and
        len(final_result) > 20
    )
    
    print(f"Data Agent call: {'✅' if 'ERROR' not in data_result else '❌'}")
    print(f"Analysis Agent call: {'✅' if 'ERROR' not in analysis_result else '❌'}")
    print(f"Main Agent synthesis: {'✅' if len(final_result) > 20 else '❌'}")
    print(f"Agent-as-Tool: {'✅ PASS' if success else '❌ FAIL'}")
    
    return success


# =============================================================================
# Pattern 5: Loop Agent (Iterative Refinement)
# =============================================================================
def test_loop_agent():
    """
    Test Loop Agent pattern with iterative refinement.
    Generates content, evaluates quality, refines until threshold met.
    """
    print("\n" + "=" * 70)
    print("Pattern 5: Loop Agent (Iterative Refinement)")
    print("=" * 70)
    print("Description: Generate → Evaluate → Refine cycle until quality threshold")
    
    session_id = f"loop_{random.randint(10000, 99999)}"
    max_iterations = 3
    quality_threshold = 7  # Out of 10
    
    # Initial generation
    print("\n--- Initial Generation ---")
    current_draft = run_turn(
        f"{session_id}_gen", 
        """Write a very brief product description (1-2 sentences) for a smart water bottle.
Make it simple and unpolished - just a rough draft.
Output ONLY the description, nothing else."""
    )
    print(f"Draft 0: {current_draft[:150]}")
    
    iterations = []
    final_score = 0
    
    for i in range(max_iterations):
        print(f"\n--- Iteration {i+1} ---")
        
        # Evaluate current draft
        eval_prompt = f"""Rate this product description from 1-10 where:
1-3: Poor (unclear, missing key info)
4-6: Average (decent but could improve)
7-10: Good (clear, compelling, complete)

Description: "{current_draft}"

Respond with ONLY a single number from 1-10."""
        
        score_response = run_turn(f"{session_id}_eval_{i}", eval_prompt)
        
        # Extract numeric score
        try:
            score = int(''.join(filter(str.isdigit, score_response[:5])))
            score = min(max(score, 1), 10)  # Clamp to 1-10
        except:
            score = 5  # Default if parsing fails
        
        print(f"Quality Score: {score}/10")
        final_score = score
        
        if score >= quality_threshold:
            print(f"✅ Threshold {quality_threshold} reached!")
            break
        
        # Refine
        refine_prompt = f"""Improve this product description to make it more compelling and clear.
Current description: "{current_draft}"
Current score: {score}/10

Write an improved version. Output ONLY the new description, nothing else."""
        
        current_draft = run_turn(f"{session_id}_refine_{i}", refine_prompt)
        print(f"Refined: {current_draft[:150]}")
        
        iterations.append({
            "iteration": i + 1,
            "score": score,
            "draft": current_draft[:100]
        })
    
    print("\n--- Final Result ---")
    print(f"Total iterations: {len(iterations) + 1}")
    print(f"Final score: {final_score}/10")
    print(f"Final draft: {current_draft[:200]}")
    
    success = final_score >= quality_threshold - 2  # Allow some tolerance
    print(f"Loop Agent: {'✅ PASS' if success else '❌ FAIL'}")
    
    return success


# =============================================================================
# Main
# =============================================================================
if __name__ == "__main__":
    print("=" * 70)
    print("Complex ADK Agent Configuration Tests")
    print("=" * 70)
    print("Testing 5 advanced multi-agent patterns\n")
    
    # Check server health first
    status, health = make_request("/health")
    if status != 200:
        print(f"❌ Server not available at {BASE_URL}")
        print("Please ensure VS Code LM Proxy extension is running.")
        exit(1)
    print(f"✅ Server healthy at {BASE_URL}\n")
    
    results = {}
    
    # Run all pattern tests
    try:
        results["sequential_pipeline"] = test_sequential_pipeline()
    except Exception as e:
        print(f"Sequential Pipeline Error: {e}")
        results["sequential_pipeline"] = False
    
    try:
        results["parallel_fanout"] = test_parallel_fanout()
    except Exception as e:
        print(f"Parallel Fan-out Error: {e}")
        results["parallel_fanout"] = False
    
    try:
        results["hierarchical_coordinator"] = test_hierarchical_coordinator()
    except Exception as e:
        print(f"Hierarchical Coordinator Error: {e}")
        results["hierarchical_coordinator"] = False
    
    try:
        results["agent_as_tool"] = test_agent_as_tool()
    except Exception as e:
        print(f"Agent-as-Tool Error: {e}")
        results["agent_as_tool"] = False
    
    try:
        results["loop_agent"] = test_loop_agent()
    except Exception as e:
        print(f"Loop Agent Error: {e}")
        results["loop_agent"] = False
    
    # Final Summary
    print("\n" + "=" * 70)
    print("FINAL RESULTS")
    print("=" * 70)
    
    pattern_names = {
        "sequential_pipeline": "Pattern 1: Sequential Pipeline",
        "parallel_fanout": "Pattern 2: Parallel Fan-out/Gather",
        "hierarchical_coordinator": "Pattern 3: Hierarchical Coordinator",
        "agent_as_tool": "Pattern 4: Agent-as-Tool",
        "loop_agent": "Pattern 5: Loop Agent (Iterative Refinement)",
    }
    
    for key, passed in results.items():
        icon = "✅" if passed else "❌"
        print(f"{icon} {pattern_names.get(key, key)}")
    
    passed_count = sum(1 for v in results.values() if v)
    total_count = len(results)
    
    print(f"\nTotal: {passed_count}/{total_count} patterns passed")
    
    if all(results.values()):
        print("\n🎉 All complex agent patterns working correctly!")
    else:
        print("\n⚠️ Some patterns need attention.")
