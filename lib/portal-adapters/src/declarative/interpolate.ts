/**
 * declarative/interpolate.ts — pure, side-effect-free template interpolation.
 *
 * Replaces {{profile.x}}, {{vars.y}}, and {{captured.z}} placeholders in a
 * template string using values from a ctx object. Missing keys within a known
 * namespace resolve to "". Placeholders with an unknown namespace (anything
 * other than profile/vars/captured) are left unchanged in the output.
 * All resolution is a single regex pass so order is irrelevant and the function
 * is safe to call on any string field in an http/graphql step.
 */

export interface InterpolateCtx {
  profile: Record<string, unknown>;
  vars: Record<string, unknown>;
  captured: Record<string, unknown>;
}

const PLACEHOLDER_RE = /\{\{(profile|vars|captured)\.([^}]+)\}\}/g;

/**
 * Interpolates `{{namespace.key}}` placeholders in `template`.
 * - Supported namespaces: `profile`, `vars`, `captured`.
 * - Unknown namespace or missing key resolves to `""`.
 * - Non-string values are coerced via `String()`.
 */
export function interpolate(template: string, ctx: InterpolateCtx): string {
  return template.replace(PLACEHOLDER_RE, (_match, ns: string, key: string) => {
    const bag =
      ns === "profile" ? ctx.profile :
      ns === "vars"    ? ctx.vars    :
      ns === "captured"? ctx.captured:
      null;
    if (bag == null) return "";
    const val = bag[key];
    if (val == null) return "";
    return String(val);
  });
}
