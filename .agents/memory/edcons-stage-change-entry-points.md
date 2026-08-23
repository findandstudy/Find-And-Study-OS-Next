---
name: edcons stage-change entry points
description: Why stage-transition rules in the edcons app must be enforced server-side, not per UI path.
---

# Application stage changes have many UI entry points

An application's pipeline stage can be changed from several distinct UI paths,
and they are easy to enumerate incompletely. Besides the obvious dedicated
"stage move" affordances (kanban drag, list/table quick actions, the detail
stage dropdown, bulk move), the stage is ALSO changeable through the general
"edit application" forms, which submit the stage field as part of an ordinary
multi-field save.

**Why it matters:** The general edit forms each issue their own PATCH and are
easy to overlook because they aren't "stage move" code. A code review caught
new stage-transition gating (document-request modals) being bypassed by exactly
those forms.

**How to apply:** Enforce any stage-transition rule on the server in the
application update endpoint (and the bulk endpoint) so no client path can bypass
it. The client should only decide which dialog to show in response to the
server's signal — never be the sole gatekeeper.

**Backward-compatibility note:** A stage action that triggers a transition side
effect may have been configured under an older model (e.g. on a source stage
with a pointer to a target stage) before being migrated to a newer model (the
action living on the target stage it relates to). When migrating such triggers,
keep the server honoring BOTH shapes so existing pipeline configurations keep
working — additive support is far safer than a hard cutover.
