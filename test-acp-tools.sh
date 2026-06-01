#!/usr/bin/env bash
# Test all ACP tools via openclaw agent
set -e

SESSION="agent:main:acp-fulltest"
AGENT_ARGS="--local --agent main --session-key $SESSION --timeout 180"

echo "=== TEST 1: acp_launch ==="
openclaw agent $AGENT_ARGS -m "Use the acp_launch tool with agent_id=qoder, task=echo hello, mode=run. Show the raw tool result."
echo ""

echo "=== TEST 2: acp_list ==="
openclaw agent $AGENT_ARGS -m "Use the acp_list tool to list all sessions. Show the raw tool result."
echo ""

echo "=== TEST 3: acp_launch (session mode) ==="
openclaw agent $AGENT_ARGS -m "Use acp_launch with agent_id=qoder, task=what is 2+2, mode=session. Show the sessionId from result."
echo ""

echo "=== TEST 4: acp_send ==="
openclaw agent $AGENT_ARGS -m "Use acp_list first to get a session in session mode, then use acp_send to send message=what is 3+3 to that session_id. Show results."
echo ""

echo "=== TEST 5: acp_config ==="
openclaw agent $AGENT_ARGS -m "Use acp_list to get any session_id, then use acp_config with that session_id, key=model, value=qwen3.5-plus. Show result."
echo ""

echo "=== TEST 6: acp_cancel ==="
openclaw agent $AGENT_ARGS -m "Use acp_list to find a running session, then use acp_cancel with that session_id and reason=testing. Show result."
echo ""

echo "=== TEST 7: acp_close ==="
openclaw agent $AGENT_ARGS -m "Use acp_list to find any session, then use acp_close on that session_id with reason=test complete. Show result."
echo ""

echo "=== ALL TESTS COMPLETE ==="
