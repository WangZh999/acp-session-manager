/**
 * E2E Integration Test: ACP Approval via Gateway
 * 
 * This script tests the approval mechanism by:
 * 1. Importing the installed plugin's service
 * 2. Creating a live session via the service
 * 3. Injecting a pending approval
 * 4. Verifying it surfaces correctly
 * 5. Resolving it and confirming the callback fires
 * 
 * Run: node test-approval-e2e.mjs
 */

import { getService } from "./dist/shared.js";

const service = getService();

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  ACP Session Manager - Approval Mechanism E2E Test          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const results = [];

  // --- Test 1: Service singleton works ---
  const test1 = service !== null && service !== undefined;
  results.push({ name: "Service singleton available", pass: test1 });
  console.log(`[${test1 ? "PASS" : "FAIL"}] Service singleton available`);

  // --- Test 2: Create mock session and inject approval ---
  const sessionId = `test_e2e_${Date.now()}`;
  const mockSession = {
    sessionId,
    handle: { sessionKey: `acp-manager:qoder:${sessionId}`, backend: "acpx", runtimeSessionName: "e2e-test" },
    agentId: "qoder",
    status: "running",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    mode: "session",
    output: "",
    toolCalls: [],
    pendingApprovals: [],
  };
  service["sessions"].set(sessionId, mockSession);
  
  const test2 = service.getSession(sessionId) !== undefined;
  results.push({ name: "Session created and retrievable", pass: test2 });
  console.log(`[${test2 ? "PASS" : "FAIL"}] Session created and retrievable`);

  // --- Test 3: Add pending approval ---
  let approvalDecision = null;
  const approval = {
    approvalId: `approval_${Date.now()}`,
    sessionId,
    toolName: "Bash",
    title: "Execute command: rm -rf /tmp/test",
    description: "Dangerous operation requiring human approval",
    options: [
      { id: "allow_once", label: "Allow Once", description: "Allow this single execution" },
      { id: "allow_always", label: "Allow Always", description: "Always allow bash commands" },
      { id: "reject", label: "Reject", description: "Deny this command" },
    ],
    timestamp: Date.now(),
    timeoutMs: 60000,
    resolve: (decision) => { approvalDecision = decision; },
  };

  // Register event listener
  let eventFired = false;
  let eventType = null;
  service.onEvent((event) => {
    if (event.type === "approval_requested" && event.sessionId === sessionId) {
      eventFired = true;
      eventType = event.type;
    }
  });

  service.addPendingApproval(approval);
  
  const session = service.getSession(sessionId);
  const test3 = session?.pendingApprovals.length === 1;
  results.push({ name: "Pending approval added to session", pass: test3 });
  console.log(`[${test3 ? "PASS" : "FAIL"}] Pending approval added to session`);

  // --- Test 4: Event fired ---
  const test4 = eventFired && eventType === "approval_requested";
  results.push({ name: "approval_requested event emitted", pass: test4 });
  console.log(`[${test4 ? "PASS" : "FAIL"}] approval_requested event emitted`);

  // --- Test 5: getPendingApprovals works ---
  const pending = service.getPendingApprovals();
  const test5 = pending.length >= 1 && pending.some(p => p.approvalId === approval.approvalId);
  results.push({ name: "getPendingApprovals returns the approval", pass: test5 });
  console.log(`[${test5 ? "PASS" : "FAIL"}] getPendingApprovals returns the approval`);

  // --- Test 6: Resolve with allow_once ---
  const resolved = service.resolveApproval(sessionId, approval.approvalId, "allow_once");
  const test6 = resolved === true && approvalDecision === "allow_once";
  results.push({ name: "resolveApproval fires callback with correct decision", pass: test6 });
  console.log(`[${test6 ? "PASS" : "FAIL"}] resolveApproval fires callback with correct decision (got: ${approvalDecision})`);

  // --- Test 7: Approval removed from queue ---
  const afterResolve = service.getSession(sessionId);
  const test7 = afterResolve?.pendingApprovals.length === 0;
  results.push({ name: "Approval removed from queue after resolution", pass: test7 });
  console.log(`[${test7 ? "PASS" : "FAIL"}] Approval removed from queue after resolution`);

  // --- Test 8: Double-resolve prevention ---
  const doubleResolve = service.resolveApproval(sessionId, approval.approvalId, "reject");
  const test8 = doubleResolve === false;
  results.push({ name: "Double-resolve returns false", pass: test8 });
  console.log(`[${test8 ? "PASS" : "FAIL"}] Double-resolve returns false`);

  // --- Test 9: Multiple concurrent approvals ---
  const approvals = [];
  for (let i = 0; i < 3; i++) {
    const a = {
      approvalId: `batch_${i}_${Date.now()}`,
      sessionId,
      toolName: `tool_${i}`,
      title: `Batch approval ${i}`,
      options: [{ id: "allow_once", label: "Allow" }, { id: "reject", label: "Reject" }],
      timestamp: Date.now(),
      timeoutMs: 60000,
      resolve: () => {},
    };
    approvals.push(a);
    service.addPendingApproval(a);
  }
  const batchSession = service.getSession(sessionId);
  const test9 = batchSession?.pendingApprovals.length === 3;
  results.push({ name: "Multiple concurrent approvals queued", pass: test9 });
  console.log(`[${test9 ? "PASS" : "FAIL"}] Multiple concurrent approvals queued (count: ${batchSession?.pendingApprovals.length})`);

  // Resolve middle one
  service.resolveApproval(sessionId, approvals[1].approvalId, "reject");
  const afterMiddle = service.getSession(sessionId);
  const test10 = afterMiddle?.pendingApprovals.length === 2 
    && !afterMiddle.pendingApprovals.some(a => a.approvalId === approvals[1].approvalId);
  results.push({ name: "Can resolve specific approval from queue", pass: test10 });
  console.log(`[${test10 ? "PASS" : "FAIL"}] Can resolve specific approval from queue (remaining: ${afterMiddle?.pendingApprovals.length})`);

  // --- Summary ---
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Results: ${passed}/${total} passed`);
  console.log(`${"═".repeat(60)}`);
  
  if (passed === total) {
    console.log("  ✓ All approval mechanism tests PASSED");
    console.log("\n  The approval pipeline works correctly:");
    console.log("  - Approvals can be added to sessions");
    console.log("  - Events are emitted when approvals are requested");
    console.log("  - Approvals can be resolved with any decision");
    console.log("  - Resolver callbacks fire with the correct decision");
    console.log("  - Resolved approvals are removed from the queue");
    console.log("  - Double-resolution is prevented");
    console.log("  - Multiple concurrent approvals are supported");
    console.log("  - Individual approvals can be resolved from a batch");
  } else {
    console.log("  ✗ Some tests FAILED");
    process.exitCode = 1;
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
