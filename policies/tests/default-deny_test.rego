package agenteval.authz

test_admin_allowed {
    allow with input as {"role": "admin", "action": "anything", "resource": "anything"}
}

test_default_deny {
    not allow with input as {"role": "user", "action": "read", "resource": "secret"}
}

test_role_permission_allowed {
    allow with input as {"role": "viewer", "action": "read", "resource": "doc"}
        with data.role_permissions as {"viewer": [{"action": "read", "resource": "doc"}]}
}
