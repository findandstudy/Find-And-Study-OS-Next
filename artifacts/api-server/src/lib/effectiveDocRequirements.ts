// API compatibility facade. The implementation lives in portal-runner so the
// HTTP layer and the always-on production worker enforce one identical rule.
export {
  getEffectiveDocRequirements,
  mandatoryDocTypes,
  type EffectiveDocRequirement,
} from "@workspace/portal-runner";
