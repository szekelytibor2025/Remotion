import {runMigrations} from '../src/db/migrate.js';
import {listApiKeys} from '../src/db/api-keys.js';

runMigrations();
const keys = listApiKeys();

if (keys.length === 0) {
  console.log('No API keys found.');
  process.exit(0);
}

console.log('');
for (const key of keys) {
  const status = key.revoked_at ? 'REVOKED' : 'ACTIVE';
  const lastUsed = key.last_used_at
    ? new Date(key.last_used_at).toISOString()
    : 'never';
  console.log(`  ${key.id}  [${status}]`);
  console.log(`    Name:       ${key.name}`);
  console.log(`    Prefix:     ${key.key_prefix}...`);
  console.log(`    Created:    ${new Date(key.created_at).toISOString()}`);
  console.log(`    Last used:  ${lastUsed}`);
  console.log(`    Rate limit: ${key.rate_limit_per_minute}/min`);
  console.log('');
}
