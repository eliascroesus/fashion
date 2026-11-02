import type { Db } from './client.ts';
import { featureFlags, profiles } from './schema/index.ts';

/** Fixed ids so the seed can run any number of times without duplicates. */
export const SEED_PROFILE_IDS = {
  personal: '00000000-0000-4000-8000-000000000001',
  creator: '00000000-0000-4000-8000-000000000002',
  business: '00000000-0000-4000-8000-000000000003',
} as const;

/** Local test data. Logins and memberships are created by the real sign-in flow. */
export async function seed(db: Db): Promise<void> {
  await db
    .insert(profiles)
    .values([
      {
        id: SEED_PROFILE_IDS.personal,
        handle: 'demo.personal',
        displayName: 'Demo Personal',
      },
      {
        id: SEED_PROFILE_IDS.creator,
        handle: 'demo.creator',
        displayName: 'Demo Creator',
        accountType: 'creator',
        creatorCategory: 'Stylist',
      },
      {
        id: SEED_PROFILE_IDS.business,
        handle: 'demo.brand',
        displayName: 'Demo Brand',
        accountType: 'business',
        brandName: 'Demo Brand',
        websiteUrl: 'https://example.com',
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(featureFlags)
    .values([
      {
        key: 'dev_menu',
        description: 'Hidden developer menu in the app',
        enabled: true,
      },
    ])
    .onConflictDoNothing();
}
