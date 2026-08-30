package agenteval.budget

default deny_budget := false

# Deny if token usage exceeds run budget
deny_budget {
    input.tokens_used > input.budget_limit
}

deny_budget {
    input.cost_incurred > input.max_cost
}
