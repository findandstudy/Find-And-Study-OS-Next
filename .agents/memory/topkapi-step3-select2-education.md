---
name: Topkapı Step 3 education-level select2 (applied degree)
description: Why Step 3 dependent fields never render, and the applied-degree + placeholder-guard rules for the education-level dropdown
---

Step 3 (education background) on the Topkapı portal AJAX-renders its dependent
row fields (schoolName / gpa / graduationDate / country) ONLY after the
education-level dropdown receives a real selection. Two traps:

1. **Never accept the placeholder as a real selection.** The level dropdown is a
   select2 whose placeholder ("Seçim Yapın") carries a non-empty value, so a
   guard of `value && value !== "0"` false-positives → the change handler never
   fires → dependent fields never render → downstream fills hit "no element
   found" / "empty after retry". Verify the read-back with a placeholder check on
   BOTH value and (folded) text, not just value, and skip option index 0.

2. **The level dropdown is the DEGREE LEVEL OF THE PROGRAM BEING APPLIED TO — NOT
   prior education.** The live widget dump proves the options are exactly the
   applied degrees: option VALUE is the English key, the label is Turkish:
   `Associate::Önlisans`, `Bachelor::Lisans`, `Masters (Non Thesis)::Yüksek Lisans
   (Tezsiz)`, `Masters (Thesis)::Yüksek Lisans (Tezli)`, `Doctorate::Doktora`.
   There is NO "Lise"/"High School". Select the applied degree by its option VALUE
   (mapEduLevel output already returns these exact keys); the matcher must compare
   candidates against BOTH option value AND text (a [Lise…] prior-education list
   matches nothing → empty field → the original bug).

**Why:** select2 keeps a hidden native `<select>` in sync, but `page.selectOption`
can't click a display:none select2. Set the value in-page and fire BOTH native
change and `jQuery(el).val(v).trigger("change")` so the widget's AJAX handler
runs; then `waitForSelector` the first dependent field before filling.

**How to apply:** Step-3 dependent fields use the `applicationEducationInformation*[]`
name family (confirmed for educationLevel + country; school/gpa/grad very likely
too — keep legacy bare names as fallbacks and dump real names after render for
evidence). Country is a select2 with numeric option VALUE (e.g. Pakistan=162) and
the country name as TEXT, so match by the resolved (Turkish) country name. Match
candidate labels against the REAL options (fold() value-exact OR text-exact, then
substring, skip index 0), set by option value in-page, verify read-back is not a
placeholder, retry once, then await the dependent field. Keep the fail-visible
gate (throw if level/school/gpa/grad stay empty). Diagnose the widget FIRST
(select2 detection + options + outerHTML) — failures are widget-specific.
