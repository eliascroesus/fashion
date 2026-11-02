import {
  and,
  boards,
  eq,
  follows,
  isNull,
  looks,
  media,
  profileMembers,
  profiles,
  saves,
  seen,
  sql,
  swipes,
  tasteProfiles,
} from '@outfitly/db';
import { apiErrorSchema, meSchema, mergeGuestResultSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROFILE_REFERENCES_HANDLED_BY_MERGE } from '../src/profiles.ts';
import { buildTestApp, createTestContext, signToken, type TestContext } from './helpers.ts';

let ctx: TestContext;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

/** A Supabase login (auth.users row) plus a token for it. */
async function login(options: { isAnonymous?: boolean; email?: string } = {}) {
  const userId = crypto.randomUUID();
  await ctx.db.execute(
    sql`INSERT INTO auth.users (id, is_anonymous) VALUES (${userId}, ${options.isAnonymous ?? false})`,
  );
  return { userId, token: await tokenFor(userId, options) };
}

async function tokenFor(userId: string, options: { isAnonymous?: boolean; email?: string } = {}) {
  return signToken({
    sub: userId,
    isAnonymous: options.isAnonymous ?? false,
    ...(options.email ? { email: options.email } : {}),
  });
}

async function post(
  token: string,
  url: string,
  payload: object = {},
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': crypto.randomUUID(),
      ...headers,
    },
    payload,
  });
}

async function startSession(token: string) {
  const res = await post(token, '/v1/session');
  expect(res.statusCode).toBe(200);
  return meSchema.parse(res.json());
}

async function addPhoto(profileId: string) {
  const id = crypto.randomUUID();
  await ctx.db
    .insert(media)
    .values({ id, ownerProfileId: profileId, originalKey: `originals/${id}` });
  return id;
}

describe('POST /v1/session', () => {
  it('gives a new login one personal profile with a generated handle, and makes it active', async () => {
    const { token, userId } = await login({ email: 'anna.svensson@example.com' });
    const me = await startSession(token);
    expect(me.userId).toBe(userId);
    expect(me.profiles).toHaveLength(1);
    expect(me.profiles[0]).toMatchObject({ accountType: 'personal', role: 'owner' });
    // Handles are public, so they never come from the email address.
    expect(me.profiles[0]?.handle).toMatch(/^user\d{4}$/);
    expect(me.activeProfileId).toBe(me.profiles[0]?.id);
  });

  it('is safe to call again and at the same time (still one profile)', async () => {
    const { token, userId } = await login();
    await Promise.all(Array.from({ length: 5 }, () => startSession(token)));
    await startSession(token);
    expect(await ctx.db.$count(profileMembers, eq(profileMembers.userId, userId))).toBe(1);
  });

  it('works for guests (anonymous logins) too', async () => {
    const { token } = await login({ isAnonymous: true });
    const me = await startSession(token);
    expect(me.isAnonymous).toBe(true);
    expect(me.profiles[0]?.handle).toMatch(/^user\d{4}$/);
  });

  it('picks another handle when the generated one is taken', async () => {
    // Take every 4-digit "user" handle so the generator has to widen.
    await ctx.db.execute(sql`
      INSERT INTO profiles (handle)
      SELECT 'user' || n FROM generate_series(1000, 9999) AS n
      ON CONFLICT DO NOTHING`);
    const { token } = await login();
    const me = await startSession(token);
    expect(me.profiles[0]?.handle).toMatch(/^user\d{8}$/);
    await ctx.db.execute(sql`DELETE FROM profiles WHERE handle ~ '^user[0-9]{4}$'
      AND id NOT IN (SELECT profile_id FROM profile_members)`);
  });
});

describe('guest → Apple (or Google/email) upgrade', () => {
  it('keeps the same login, profile and data', async () => {
    // Supabase links the new identity to the guest, so the user id stays the same.
    const { userId, token: guestToken } = await login({ isAnonymous: true });
    const guest = await startSession(guestToken);
    const photo = await addPhoto(guest.activeProfileId ?? '');

    await ctx.db.execute(sql`UPDATE auth.users SET is_anonymous = false WHERE id = ${userId}`);
    const upgradedToken = await tokenFor(userId, { email: 'anna@privaterelay.appleid.com' });
    const upgraded = await startSession(upgradedToken);

    expect(upgraded.userId).toBe(guest.userId);
    expect(upgraded.isAnonymous).toBe(false);
    expect(upgraded.profiles).toEqual(guest.profiles);
    const [row] = await ctx.db.select().from(media).where(eq(media.id, photo));
    expect(row?.ownerProfileId).toBe(guest.activeProfileId);
  });
});

describe('acting as a profile (X-Profile-Id)', () => {
  it('uses the named profile when the login may act for it', async () => {
    const { token } = await login();
    const me = await startSession(token);
    const res = await post(
      token,
      '/v1/media/uploads',
      { contentType: 'image/jpeg', byteSize: 10 },
      {
        'x-profile-id': me.activeProfileId ?? '',
      },
    );
    expect(res.statusCode).toBe(201);
  });

  it("refuses someone else's profile", async () => {
    const alice = await login();
    const bob = await login();
    const bobsProfile = (await startSession(bob.token)).activeProfileId ?? '';
    await startSession(alice.token);
    const res = await post(
      alice.token,
      '/v1/media/uploads',
      { contentType: 'image/jpeg', byteSize: 10 },
      {
        'x-profile-id': bobsProfile,
      },
    );
    expect(res.statusCode).toBe(403);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('forbidden');
  });

  it('refuses a header that is not a profile id', async () => {
    const { token } = await login();
    await startSession(token);
    const res = await post(
      token,
      '/v1/media/uploads',
      { contentType: 'image/jpeg', byteSize: 10 },
      {
        'x-profile-id': 'nope',
      },
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/session/merge-guest (email already had an account)', () => {
  it("moves the guest's photos to the account and closes the guest profile", async () => {
    const guest = await login({ isAnonymous: true });
    const guestProfile = (await startSession(guest.token)).activeProfileId ?? '';
    const photo = await addPhoto(guestProfile);

    const existing = await login({ email: 'existing@example.com' });
    const account = await startSession(existing.token);

    const res = await post(existing.token, '/v1/session/merge-guest', {
      guestAccessToken: guest.token,
    });
    expect(res.statusCode).toBe(200);
    expect(mergeGuestResultSchema.parse(res.json())).toEqual({ merged: true });

    const [moved] = await ctx.db.select().from(media).where(eq(media.id, photo));
    expect(moved?.ownerProfileId).toBe(account.activeProfileId);
    const [closed] = await ctx.db.select().from(profiles).where(eq(profiles.id, guestProfile));
    expect(closed?.deletedAt).not.toBeNull();
    expect(await ctx.db.$count(profileMembers, eq(profileMembers.userId, guest.userId))).toBe(0);

    // Running it again (a retry) finds nothing left to move.
    const again = await post(existing.token, '/v1/session/merge-guest', {
      guestAccessToken: guest.token,
    });
    expect(again.json()).toEqual({ merged: false });
  });

  it("moves saves, boards, follows and taste without duplicates, keeping the account's own", async () => {
    const guest = await login({ isAnonymous: true });
    const guestProfile = (await startSession(guest.token)).activeProfileId ?? '';
    const existing = await login({ email: 'collector@example.com' });
    const accountProfile = (await startSession(existing.token)).activeProfileId ?? '';
    const [creator] = await ctx.db
      .insert(profiles)
      .values({ handle: `creator.${String(Date.now())}` })
      .returning({ id: profiles.id });
    const creatorId = creator?.id ?? '';
    const lookIds = await ctx.db
      .insert(looks)
      .values(
        ['a', 'b', 'c'].map((x) => ({
          authorProfileId: creatorId,
          slug: `merge-${x}-${crypto.randomUUID().slice(0, 8)}`,
        })),
      )
      .returning({ id: looks.id });
    const [lookA, lookB, lookC] = lookIds.map((l) => l.id) as [string, string, string];

    // Account: saved A; saved B then unsaved it; follows the creator; has a taste profile.
    await ctx.db.insert(saves).values([
      { profileId: accountProfile, lookId: lookA },
      { profileId: accountProfile, lookId: lookB, deletedAt: new Date() },
    ]);
    await ctx.db
      .insert(follows)
      .values({ followerProfileId: accountProfile, followedProfileId: creatorId });
    await ctx.db.insert(tasteProfiles).values({ profileId: accountProfile, styles: ['minimal'] });
    // Guest: saved A, B and C; a board; followed the creator and the account itself; own taste.
    await ctx.db
      .insert(saves)
      .values([lookA, lookB, lookC].map((lookId) => ({ profileId: guestProfile, lookId })));
    const [board] = await ctx.db
      .insert(boards)
      .values({ profileId: guestProfile, name: 'Autumn' })
      .returning({ id: boards.id });
    await ctx.db.insert(follows).values([
      { followerProfileId: guestProfile, followedProfileId: creatorId },
      { followerProfileId: guestProfile, followedProfileId: accountProfile },
    ]);
    await ctx.db.insert(tasteProfiles).values({ profileId: guestProfile, styles: ['street'] });

    const res = await post(existing.token, '/v1/session/merge-guest', {
      guestAccessToken: guest.token,
    });
    expect(res.json()).toEqual({ merged: true });

    const activeSaves = await ctx.db
      .select({ lookId: saves.lookId })
      .from(saves)
      .where(and(eq(saves.profileId, accountProfile), isNull(saves.deletedAt)));
    expect(activeSaves.map((r) => r.lookId).sort()).toEqual([lookA, lookB, lookC].sort());
    expect(await ctx.db.$count(saves, eq(saves.profileId, accountProfile))).toBe(3);

    const [movedBoard] = await ctx.db
      .select()
      .from(boards)
      .where(eq(boards.id, board?.id ?? ''));
    expect(movedBoard?.profileId).toBe(accountProfile);

    const accountFollows = await ctx.db
      .select({ followed: follows.followedProfileId })
      .from(follows)
      .where(eq(follows.followerProfileId, accountProfile));
    expect(accountFollows).toEqual([{ followed: creatorId }]);

    const [taste] = await ctx.db
      .select({ styles: tasteProfiles.styles })
      .from(tasteProfiles)
      .where(eq(tasteProfiles.profileId, accountProfile));
    expect(taste?.styles).toEqual(['minimal']);
  });

  it('handles follows in both directions and leaves nothing active on the closed guest profile', async () => {
    const guest = await login({ isAnonymous: true });
    const guestProfile = (await startSession(guest.token)).activeProfileId ?? '';
    const existing = await login({ email: 'follows@example.com' });
    const accountProfile = (await startSession(existing.token)).activeProfileId ?? '';
    const stamp = String(Date.now());
    const others = await ctx.db
      .insert(profiles)
      .values(['fan', 'friend', 'ex', 'creator'].map((name) => ({ handle: `${name}.${stamp}` })))
      .returning({ id: profiles.id });
    const [fan, friend, ex, creator] = others.map((p) => p.id) as [string, string, string, string];
    const [look] = await ctx.db
      .insert(looks)
      .values({ authorProfileId: creator, slug: `follow-merge-${stamp}` })
      .returning({ id: looks.id });
    const lookId = look?.id ?? '';
    const gone = new Date();
    await ctx.db.insert(follows).values([
      // The account had unfollowed the creator; the guest follows them now.
      { followerProfileId: accountProfile, followedProfileId: creator, deletedAt: gone },
      { followerProfileId: guestProfile, followedProfileId: creator },
      // A fan only knew the guest; a friend follows both; the account follows the guest.
      { followerProfileId: fan, followedProfileId: guestProfile },
      { followerProfileId: friend, followedProfileId: guestProfile },
      { followerProfileId: friend, followedProfileId: accountProfile },
      { followerProfileId: accountProfile, followedProfileId: guestProfile },
      // Someone who unfollowed the account on purpose, then followed the guest.
      { followerProfileId: ex, followedProfileId: accountProfile, deletedAt: gone },
      { followerProfileId: ex, followedProfileId: guestProfile },
    ]);
    await ctx.db.insert(swipes).values([
      { profileId: accountProfile, lookId, kind: 'skip' },
      { profileId: guestProfile, lookId, kind: 'see_less' },
    ]);
    await ctx.db.insert(seen).values({ profileId: guestProfile, lookId });

    const res = await post(existing.token, '/v1/session/merge-guest', {
      guestAccessToken: guest.token,
    });
    expect(res.json()).toEqual({ merged: true });

    const active = await ctx.db
      .select({ from: follows.followerProfileId, to: follows.followedProfileId })
      .from(follows)
      .where(
        and(
          isNull(follows.deletedAt),
          sql`${accountProfile} IN (${follows.followerProfileId}, ${follows.followedProfileId})`,
        ),
      );
    expect(active).toEqual(
      expect.arrayContaining([
        { from: accountProfile, to: creator }, // revived: the guest's follow is newer
        { from: fan, to: accountProfile },
        { from: friend, to: accountProfile },
      ]),
    );
    expect(active).toHaveLength(3); // not the ex: their unfollow of the account stands

    const [swipe] = await ctx.db.select().from(swipes).where(eq(swipes.profileId, accountProfile));
    expect(swipe?.kind).toBe('skip'); // the account's own reaction wins
    expect(await ctx.db.$count(seen, eq(seen.profileId, accountProfile))).toBe(1);

    // Nothing on the closed guest profile can count twice.
    const leftovers = await ctx.db.execute<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM saves WHERE profile_id = ${guestProfile} AND deleted_at IS NULL)
           + (SELECT count(*) FROM follows WHERE deleted_at IS NULL
                AND ${guestProfile} IN (follower_profile_id, followed_profile_id))
           + (SELECT count(*) FROM swipes WHERE profile_id = ${guestProfile})
           + (SELECT count(*) FROM seen WHERE profile_id = ${guestProfile})
           + (SELECT count(*) FROM taste_profiles WHERE profile_id = ${guestProfile}) AS n`);
    expect(Number(leftovers.rows[0]?.n)).toBe(0);
  });

  it('lets two guests merge into one account at the same moment', async () => {
    const existing = await login({ email: 'busy@example.com' });
    const accountProfile = (await startSession(existing.token)).activeProfileId ?? '';
    const [creator] = await ctx.db
      .insert(profiles)
      .values({ handle: `busy.creator.${String(Date.now())}` })
      .returning({ id: profiles.id });
    const [look] = await ctx.db
      .insert(looks)
      .values({ authorProfileId: creator?.id ?? '', slug: `busy-${String(Date.now())}` })
      .returning({ id: looks.id });
    const guests = await Promise.all([1, 2].map(() => login({ isAnonymous: true })));
    for (const g of guests) {
      const profileId = (await startSession(g.token)).activeProfileId ?? '';
      await ctx.db.insert(saves).values({ profileId, lookId: look?.id ?? '' });
    }

    const results = await Promise.all(
      guests.map((g) =>
        post(existing.token, '/v1/session/merge-guest', { guestAccessToken: g.token }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await ctx.db.$count(saves, eq(saves.profileId, accountProfile))).toBe(1);
  });

  it("gives the account the guest's taste picks when it has none of its own", async () => {
    const guest = await login({ isAnonymous: true });
    const guestProfile = (await startSession(guest.token)).activeProfileId ?? '';
    await ctx.db.insert(tasteProfiles).values({ profileId: guestProfile, brands: ['Arket'] });
    const existing = await login({ email: 'newbie@example.com' });
    const accountProfile = (await startSession(existing.token)).activeProfileId ?? '';

    await post(existing.token, '/v1/session/merge-guest', { guestAccessToken: guest.token });

    const [taste] = await ctx.db
      .select({ brands: tasteProfiles.brands })
      .from(tasteProfiles)
      .where(eq(tasteProfiles.profileId, accountProfile));
    expect(taste?.brands).toEqual(['Arket']);
  });

  it('refuses a token that is not a guest', async () => {
    const other = await login();
    const me = await login();
    await startSession(me.token);
    const res = await post(me.token, '/v1/session/merge-guest', { guestAccessToken: other.token });
    expect(res.statusCode).toBe(403);
  });

  it('refuses when the caller is a guest', async () => {
    const guestA = await login({ isAnonymous: true });
    const guestB = await login({ isAnonymous: true });
    await startSession(guestA.token);
    const res = await post(guestA.token, '/v1/session/merge-guest', {
      guestAccessToken: guestB.token,
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a forged guest token as a bad request (the caller stays logged in)', async () => {
    const me = await login();
    await startSession(me.token);
    const res = await post(me.token, '/v1/session/merge-guest', {
      guestAccessToken: 'not.a.token',
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses an old guest token once that guest has upgraded (can't merge a real account away)", async () => {
    const victim = await login({ isAnonymous: true });
    const victimProfile = (await startSession(victim.token)).activeProfileId ?? '';
    const photo = await addPhoto(victimProfile);
    // The victim upgrades in place; their old guest token is still valid for a while.
    await ctx.db.execute(
      sql`UPDATE auth.users SET is_anonymous = false WHERE id = ${victim.userId}`,
    );

    const attacker = await login();
    await startSession(attacker.token);
    const res = await post(attacker.token, '/v1/session/merge-guest', {
      guestAccessToken: victim.token,
    });
    expect(res.statusCode).toBe(403);

    const [row] = await ctx.db.select().from(media).where(eq(media.id, photo));
    expect(row?.ownerProfileId).toBe(victimProfile);
    expect(await ctx.db.$count(profileMembers, eq(profileMembers.userId, victim.userId))).toBe(1);
  });

  it('refuses to merge into a profile named by a stale X-Profile-Id header', async () => {
    const guest = await login({ isAnonymous: true });
    const guestProfile = (await startSession(guest.token)).activeProfileId ?? '';
    const existing = await login();
    await startSession(existing.token);
    const res = await post(
      existing.token,
      '/v1/session/merge-guest',
      { guestAccessToken: guest.token },
      { 'x-profile-id': guestProfile },
    );
    expect(res.statusCode).toBe(403);
  });

  it('covers every table that belongs to a profile', async () => {
    // A new profile-owned table (saves, boards…) must be added to moveProfileContent.
    const { rows } = await ctx.db.execute<{ ref: string }>(sql`
      SELECT con.conrelid::regclass::text || '.' || att.attname AS ref
        FROM pg_constraint con
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
       WHERE con.contype = 'f' AND con.confrelid = 'public.profiles'::regclass
       ORDER BY 1`);
    expect(rows.map((r) => r.ref)).toEqual([...PROFILE_REFERENCES_HANDLED_BY_MERGE].sort());
  });
});
