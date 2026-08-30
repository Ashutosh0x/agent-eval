package agenteval.tools

import future.keywords.in

default allow_tool := false

# T5 Tactic: Restrict tool access by role and context
allow_tool {
    allowed_tools := data.role_tools[input.role]
    input.tool in allowed_tools
    input.context == "sandbox"
}

allow_tool {
    input.role == "admin"
}
