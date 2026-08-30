package agenteval.egress

test_allowed_domain {
    allow_egress with input as {"task_id": "task_1", "domain": "api.github.com"}
        with data.task_allowlist as {"task_1": ["api.github.com"]}
}

test_denied_domain {
    not allow_egress with input as {"task_id": "task_1", "domain": "evil.com"}
        with data.task_allowlist as {"task_1": ["api.github.com"]}
}
