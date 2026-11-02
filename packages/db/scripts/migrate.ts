import { runMigrations } from '../src/migrate.ts';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set. Add it to .env (see .env.example).');
  process.exit(1);
}

await runMigrations(url);
console.log('Migrations applied.');
