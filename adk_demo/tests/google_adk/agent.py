"""
Simple ADK Agent that connects to VS Code LM Proxy Server.
Tests multi-turn conversation to verify iterative dialogue works.
"""

from google.adk.agents import Agent
from google.adk.models.lite_llm import LiteLlm
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService


# Create agent with LiteLLM pointing to our proxy server
agent = Agent(
    name="simple_math_agent",
    model=LiteLlm(
        model="openai/gpt-4",  # Model name (will be passed to proxy)
        api_base="http://127.0.0.1:3141/v1",  # Our proxy server
        api_key="dummy-key",  # Required but not used by our proxy
    ),
    instruction="""You are a helpful math assistant. 
    When asked math questions, solve them step by step.
    Keep your answers concise.""",
)
