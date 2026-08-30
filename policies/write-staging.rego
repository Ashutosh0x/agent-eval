package agenteval.staging

import future.keywords.in

default stage_write := false

# T6 Tactic: Convert irreversible writes to staged drafts requiring approval
stage_write {
    input.action == "write"
    input.environment == "production"
}

stage_write {
    input.action == "update"
    input.criticality == "high"
}
