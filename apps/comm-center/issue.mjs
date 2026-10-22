// Register an agent: node issue.mjs <agents-file> <id> <manager|worker> <token-file>
// Creates the token file (never overwrites it) and stores only its hash in the agents file.
import { issueToken } from './registry.mjs';

const [agentsFile, id, role, tokenFile, ...rest] = process.argv.slice(2);
if (!tokenFile || rest.length) {
  console.error('usage: npm run issue -- <agents-file> <id> <manager|worker> <token-file>');
  process.exit(2);
}
try {
  await issueToken({ agentsFile, id, role, tokenFile });
  console.log(`registered ${id} (${role}); token written to ${tokenFile}. Copy it to that agent's machine and restart comm-center.`);
} catch (error) {
  console.error(error.code === 'EEXIST' ? `comm-center: ${tokenFile} already exists; choose a new path` : error.message);
  process.exit(1);
}
