package agenteval.authz

import future.keywords.in

default allow := false

# Allow if the action is explicitly permitted for the given role
allow {
    input.role == "admin"
}

allow {
    some permission in data.role_permissions[input.role]
    permission.action == input.action
    permission.resource == input.resource
}
