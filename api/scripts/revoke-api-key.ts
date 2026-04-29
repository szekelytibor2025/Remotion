import {runMigrations} from '../src/db/migrate.js';
import {revokeApiKey} from '../src/db/api-keys.js';

const id = process.argv[2];
if (!id) {
  console.error('Usage: npm run revoke-key -- <key_id>');
  process.exit(1);
}

runMigrations();
const ok = revokeApiKey(id);
if (!ok) {
  console.error(`Key ${id} not found or already revoked.`);
  process.exit(1);
}
console.log(`Key ${id} revoked.`);
