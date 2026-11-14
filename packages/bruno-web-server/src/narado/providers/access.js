/**
 * narado's three access levels, mapped from each Git host's own model (design §7.1).
 *
 *   read  - browse collections and send requests
 *   write - edit, push branches, open merge requests
 *   admin - repo settings for narado (for example the host allowlist)
 */
const LEVELS = ['none', 'read', 'write', 'admin'];

const rank = (level) => Math.max(0, LEVELS.indexOf(level));

const highest = (...levels) => levels.reduce((best, l) => (rank(l) > rank(best) ? l : best), 'none');

/**
 * GitHub repo permissions object: { admin, maintain, push, triage, pull }.
 * read/triage -> read, write/maintain -> write, admin -> admin.
 */
const fromGitHubPermissions = (permissions = {}) => {
  if (permissions.admin) return 'admin';
  if (permissions.maintain || permissions.push) return 'write';
  if (permissions.triage || permissions.pull) return 'read';
  return 'none';
};

/**
 * GitLab access level numbers:
 * 10 Guest, 15 Planner, 20 Reporter, 30 Developer, 40 Maintainer, 50 Owner.
 * Guest/Planner/Reporter -> read, Developer -> write, Maintainer/Owner -> admin.
 */
const fromGitLabAccessLevel = (level) => {
  if (typeof level !== 'number' || level <= 0) return 'none';
  if (level >= 40) return 'admin';
  if (level >= 30) return 'write';
  return 'read';
};

module.exports = { LEVELS, rank, highest, fromGitHubPermissions, fromGitLabAccessLevel };
