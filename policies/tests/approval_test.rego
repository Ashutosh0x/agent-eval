package agenteval.approval

test_destructive_action_requires_approval {
    require_approval with input as {"action": "delete"}
}

test_safe_action_does_not_require_approval {
    not require_approval with input as {"action": "read"}
}

test_high_cost_requires_approval {
    require_approval with input as {"cost": 1500}
        with data.budget as {"threshold": 1000}
}
