---
name: SIT wizard deep-DOM fill & save proof
description: SIT create-wizard controls may hide in frames/shadow roots; save success needs positive proof, never absence-of-error.
---
- SIT wizard controls (phone, residence select) can be missed by top-document querySelector — form dump and fills must walk ALL page.frames() AND open shadow roots (string-evaluate JS to dodge esbuild __name).
- Deep frame-scan loops must only `break` on POSITIVE proof (e.g. `val=` readback); breaking on any non-"no-el" result lets an eval-err in frame 1 abort the real input in frame 2.
- **Save success rule:** never `saved=true` from "no error text matched". Proof = redirect off the create route, else quick GraphQL findStudent by email/passport. "Save button disappeared" alone is NOT proof (overlays hide it transiently).
- Always read inline validation ([aria-invalid], .error, [role=alert]) after each save click and surface it; track `phone` in the critical/everSet map so failures can honestly say "zorunlu alan doldurulamadı (telefon)".
