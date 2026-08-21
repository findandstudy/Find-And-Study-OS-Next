const { existsSync } = require("node:fs");
const path = require("node:path");

const FOREIGN_LOCKFILES = ["package-lock.json", "yarn.lock"];
const REQUIRED_USER_AGENT = /^pnpm\/10\.33\.2(?:\s|$)/;

function enforcePnpm({
  repoRoot = path.resolve(__dirname, ".."),
  userAgent = process.env.npm_config_user_agent,
} = {}) {
  if (typeof userAgent !== "string" || !REQUIRED_USER_AGENT.test(userAgent)) {
    return {
      allowed: false,
      message: "Use pnpm instead (required version: pnpm@10.33.2)",
    };
  }

  const foreignLockfile = FOREIGN_LOCKFILES.find((lockfile) =>
    existsSync(path.join(repoRoot, lockfile)),
  );
  if (foreignLockfile) {
    return {
      allowed: false,
      message: `Remove ${foreignLockfile}; pnpm-lock.yaml is the only supported lockfile`,
    };
  }

  return { allowed: true };
}

if (require.main === module) {
  const result = enforcePnpm();
  if (!result.allowed) {
    console.error(result.message);
    process.exit(1);
  }
}

module.exports = { enforcePnpm };
