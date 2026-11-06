import { type Db, eq, featureFlags } from '@outfitly/db';

/** Whether a feature flag is on for everyone, or for this profile as a tester. Unknown = off. */
export async function isFlagOn(db: Db, key: string, profileId: string | null): Promise<boolean> {
  const [flag] = await db
    .select({ enabled: featureFlags.enabled, testers: featureFlags.enabledProfileIds })
    .from(featureFlags)
    .where(eq(featureFlags.key, key));
  if (!flag) return false;
  return flag.enabled || (profileId !== null && flag.testers.includes(profileId));
}
