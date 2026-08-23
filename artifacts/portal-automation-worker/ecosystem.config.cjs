// Compatibility entrypoint only. The repository has exactly one authoritative
// PM2 topology; invoke it from the repository root via deploy/deploy.sh.
module.exports = require("../../deploy/ecosystem.config.cjs");
