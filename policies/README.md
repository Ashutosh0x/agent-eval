# Policies

This directory contains OPA (Open Policy Agent) Rego policies for deterministic, auditable agent governance.
These policies ensure that agent actions comply with safety, budget, and regulatory constraints.

## System Overview

Agent evaluation environments use OPA to enforce authorization decisions.
All actions proposed by an agent are evaluated against these policies before execution.

## Policies

- `default-deny.rego`: Implements a default-deny posture. All actions are blocked unless explicitly allowed.
- `approval-required.rego`: Defines rules for actions that require human approval.
- `write-staging.rego`: T6 tactic: converts irreversible writes to staged drafts.
- `tool-fencing.rego`: T5 tactic: restricts tool access based on role and context.
- `egress-allowlist.rego`: Controls outbound network connections.
- `budget-limit.rego`: Enforces token and compute budget limits.
