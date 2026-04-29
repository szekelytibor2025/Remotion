import {runMigrations} from '../src/db/migrate.js';
import {generateApiKey} from '../src/db/api-keys.js';

const name = process.argv[2];
const rateLimit = process.argv[3] ? Number(process.argv[3]) : 60;

if (!name) {
  console.error('Usage: npm run create-key -- <name> [rateLimitPerMinute]');
  process.exit(1);
}

runMigrations();
const {id, rawKey} = generateApiKey(name, rateLimit);

console.log('');
console.log('  API key created successfully');
console.log('  ─────────────────────────────────────────────────────────────');
console.log(`  ID:         ${id}`);
console.log(`  Name:       ${name}`);
console.log(`  Rate limit: ${rateLimit} req/min`);
console.log(`  Key:        ${rawKey}`);
console.log('');
console.log('  Store this key securely. It cannot be retrieved later.');
console.log('  Use it as: Authorization: Bearer <key>');
console.log('');
