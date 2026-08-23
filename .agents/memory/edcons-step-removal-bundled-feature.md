---
name: Removing a wizard step can silently drop a bundled non-AI feature
description: When deleting a multi-step dialog step, check for plain functionality bundled inside it before removing.
---

When simplifying a multi-step dialog by deleting a whole step, audit what UI that step contained beyond the headline feature being removed.

**Why:** In the Course Finder ApplyDialog, the "review" step bundled BOTH the AI-extracted personal-info form AND a plain `notes` (Note optional) textarea. Removing the step to strip AI also removed the only UI to set `notes` — `handleSubmit` still sent `notes` but it was always empty. A silent feature regression, not a compile error (state still existed).

**How to apply:** Before deleting a step's JSX, grep for every state setter the step rendered (e.g. `setNotes`) and confirm whether each belongs to the feature being removed or is independent. Re-home the independent controls (notes, optional fields) into a surviving step rather than letting them become unreachable. Also add a defensive guard in the submit handler mirroring the disabled condition (`if (!allRequiredUploaded) return`), not just the button `disabled` prop.
