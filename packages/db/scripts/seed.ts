import { createDb } from '../src/client.ts';
import { seed } from '../src/seed.ts';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set. Add it to .env (see .env.example).');
  process.exit(1);
}
if (process.env['NODE_ENV'] === 'production') {
  console.error('Refusing to seed test data with NODE_ENV=production.');
  process.exit(1);
}

const db = createDb(url, { caCert: process.env['DATABASE_CA_CERT'] });
try {
  await seed(db);
  console.log('Seed data loaded.');
} finally {
  await db.$client.end();
}
