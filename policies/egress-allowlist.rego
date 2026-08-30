package agenteval.egress

import future.keywords.in

default allow_egress := false

# Default deny all outbound. Allow only domains in per-task allowlist.
allow_egress {
    allowed_domains := data.task_allowlist[input.task_id]
    input.domain in allowed_domains
}

allow_egress {
    # Always allow local telemetry if configured
    input.domain == "telemetry.internal"
}
