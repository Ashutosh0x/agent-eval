package agenteval.approval

import future.keywords.in

default require_approval := false

# Require approval if action is destructive
require_approval {
    destructive_actions := {"delete", "write_prod", "drop_db"}
    input.action in destructive_actions
}

# Require approval if cost exceeds threshold
require_approval {
    input.cost > data.budget.threshold
}

# Require approval if tool is restricted
require_approval {
    restricted_tools := {"shell", "aws_cli", "kubernetes_admin"}
    input.tool in restricted_tools
}
