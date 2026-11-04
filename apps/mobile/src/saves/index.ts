import {
  BRAND_IDS,
  feedCardSchema,
  type FeedCard,
  knownStyles,
  type LookDetail,
} from '@outfitly/shared';
import { randomUUID } from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { z } from 'zod';
import { api } from '../api';
import { getActiveProfileId, getMe, subscribeMe } from '../auth/store';
import { findCachedCard } from '../feed/cache';
import { FEED_QUERY_ROOT, feedQueryKey } from '../feed/keys';
import { LOOK_QUERY_ROOT } from '../looks/keys';
import { PROFILE_QUERY_ROOT } from '../profiles/keys';
import { queryClient } from '../lib/query';
import { storage } from '../lib/storage';
import { realTimers } from '../lib/timers';
import { addToListTop, removeFromLists, setSavedInLists } from './cache';
import {
  BOARD_LOOKS_QUERY_ROOT,
  boardLooksQueryKey,
  BOARDS_QUERY_ROOT,
  SAVES_QUERY_ROOT,
  savesQueryKey,
} from './keys';
import { Outbox, type OutboxView, type PendingAction } from './outbox';

const OUTBOX_KEY = 'saves.outbox';

const pendingSchema = z.object({
  id: z.string(),
  refusals: z.number().optional(),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('save'), lookId: z.string(), card: feedCardSchema.optional() }),
    z.object({ kind: z.literal('unsave'), lookId: z.string() }),
    z.object({
      kind: z.literal('board-add'),
      boardId: z.string(),
      lookId: z.string(),
      card: feedCardSchema.optional(),
    }),
    z.object({ kind: z.literal('board-remove'), boardId: z.string(), lookId: z.string() }),
    z.object({ kind: z.literal('see-less'), lookId: z.string() }),
    z.object({ kind: z.literal('follow'), profileId: z.string() }),
    z.object({ kind: z.literal('unfollow'), profileId: z.string() }),
    // Loose on purpose: a style or brand dropped in a later version mustn't wipe waiting saves.
    z.object({
      kind: z.literal('taste'),
      styles: z.array(z.string()),
      brands: z.array(z.string()),
    }),
  ]),
});

function load(): PendingAction[] {
  try {
    // An older app version may have stored another shape: start empty then.
    const parsed = z
      .array(pendingSchema)
      .safeParse(JSON.parse(storage.getString(OUTBOX_KEY) ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** One request per action; `id` is its Idempotency-Key, the same on every retry. */
function send({ id, action }: PendingAction): Promise<unknown> {
  switch (action.kind) {
    case 'save':
      return api.saves.save(action.lookId, id);
    case 'unsave':
      return api.saves.unsave(action.lookId, id);
    case 'board-add':
      return api.boards.addLook(action.boardId, action.lookId, id);
    case 'board-remove':
      return api.boards.removeLook(action.boardId, action.lookId, id);
    case 'see-less':
      return api.saves.seeLess(action.lookId, id);
    case 'follow':
      return api.follows.follow(action.profileId, id);
    case 'unfollow':
      return api.follows.unfollow(action.profileId, id);
    case 'taste':
      return api.taste.save(
        {
          styles: knownStyles(action.styles),
          brands: BRAND_IDS.filter((brand) => action.brands.includes(brand)),
        },
        id,
      );
  }
}

/** Updates cached look pages (saved flag, following the poster) to what the server now has. */
function editLookPages(edit: (look: LookDetail) => LookDetail): void {
  queryClient.setQueriesData<LookDetail>({ queryKey: [LOOK_QUERY_ROOT] }, (look) =>
    look ? edit(look) : look,
  );
}

let startGuestSession: (() => Promise<unknown>) | null = null;

/**
 * Saved or not, as the server confirmed this launch: newer than any card
 * loaded before it, and it survives screens that hold an old copy of a card.
 */
const confirmed = new Map<string, boolean>();
/** Following or not, as the server confirmed this launch (same idea, by profile). */
const confirmedFollows = new Map<string, boolean>();

/** Saves, board changes and "see less", kept on the phone until the server has them. */
export const outbox = new Outbox({
  load,
  save: (actions) => {
    storage.set(OUTBOX_KEY, JSON.stringify(actions));
  },
  send: async (pending) => {
    await send(pending);
  },
  hasProfile: () => getActiveProfileId() !== null,
  startSession: async () => {
    if (!startGuestSession) throw new Error('Sign-in is not set up yet.');
    await startGuestSession();
  },
  newId: randomUUID,
  timers: realTimers,
  onSent: ({ action }) => {
    // What the server has now: corrects any list that loaded while it was on its way,
    // and keeps the look in Saved (and its board) until those lists load again.
    const profileId = getActiveProfileId();
    if (action.kind === 'follow' || action.kind === 'unfollow') {
      const following = action.kind === 'follow';
      confirmedFollows.set(action.profileId, following);
      editLookPages((look) =>
        look.author.id === action.profileId
          ? { ...look, author: { ...look.author, isFollowing: following } }
          : look,
      );
      // Their looks join (or leave) Following: a fresh list, loaded now if it's open, else when shown.
      void queryClient.resetQueries({ queryKey: feedQueryKey('following', profileId) });
      // Follower and following counts.
      void queryClient.invalidateQueries({ queryKey: [PROFILE_QUERY_ROOT] });
      return;
    }
    if (action.kind === 'save' || action.kind === 'board-add') {
      confirmed.set(action.lookId, true);
      editLookPages((look) => (look.id === action.lookId ? { ...look, saved: true } : look));
      setSavedInLists(queryClient, action.lookId, true);
      if (action.card) addToListTop(queryClient, savesQueryKey(profileId), action.card);
      if (action.kind === 'board-add' && action.card) {
        addToListTop(queryClient, boardLooksQueryKey(profileId, action.boardId), action.card);
      }
    } else if (action.kind === 'unsave') {
      confirmed.set(action.lookId, false);
      editLookPages((look) => (look.id === action.lookId ? { ...look, saved: false } : look));
      setSavedInLists(queryClient, action.lookId, false);
    }
  },
  // Saves and boards loaded while actions were waiting (or dropped) may be off.
  onDrained: () => {
    refreshSavedLists();
  },
});

/**
 * Loads Saves and boards again (those on screen now, the rest when next
 * shown): after actions reached the server, or a guest's saves moved to the account.
 */
export function refreshSavedLists(): void {
  for (const root of [SAVES_QUERY_ROOT, BOARDS_QUERY_ROOT, BOARD_LOOKS_QUERY_ROOT]) {
    void queryClient.invalidateQueries({ queryKey: [root] });
  }
}

/**
 * The AuthProvider hands over how to make a guest session (it needs the
 * CAPTCHA). Only a waiting save ever uses it: the first save makes the guest.
 */
export function setGuestSessionStarter(start: (() => Promise<unknown>) | null): void {
  startGuestSession = start;
  if (start) void outbox.flush();
}

// Try again when the app comes back (e.g. after airplane mode) and when a profile appears.
AppState.addEventListener('change', (state) => {
  if (state === 'active') void outbox.flush();
});
let lastProfileId = getActiveProfileId();
subscribeMe(() => {
  const profileId = getActiveProfileId();
  if (profileId === lastProfileId) return;
  lastProfileId = profileId;
  // What the server confirmed was for the previous profile (a guest merge, sign-out, later switching).
  confirmed.clear();
  confirmedFollows.clear();
  if (profileId) void outbox.flush();
});

const subscribe = (listener: () => void) => outbox.subscribe(listener);

/** What this phone knows beyond the card: a waiting action, else what the server confirmed. */
function localSavedState(lookId: string): boolean | undefined {
  return outbox.savedState(lookId) ?? confirmed.get(lookId);
}

/** Whether the look shows as saved: a waiting action wins over what the server said. */
export function useIsSaved(lookId: string, fromServer: boolean): boolean {
  return useSyncExternalStore(subscribe, () => localSavedState(lookId)) ?? fromServer;
}

/** Whether the viewer follows the profile: a waiting follow/unfollow wins over what the server said. */
export function useIsFollowing(profileId: string, fromServer: boolean): boolean {
  return (
    useSyncExternalStore(
      subscribe,
      () => outbox.followState(profileId) ?? confirmedFollows.get(profileId),
    ) ?? fromServer
  );
}

/** Follows or unfollows (needs a login: logged out, the author row opens the sign-up sheet). */
export function setFollowing(profileId: string, following: boolean): void {
  if (following) tap();
  outbox.add({ kind: following ? 'follow' : 'unfollow', profileId });
}

/** Sign-out: nothing waiting or remembered may be sent or shown as the next login. */
export function forgetLocalSaves(): void {
  confirmed.clear();
  confirmedFollows.clear();
  outbox.clear();
}

/** What is waiting on the phone; a new object whenever that changes (lists merge it in). */
export function useOutboxView(): OutboxView {
  return useSyncExternalStore(subscribe, () => outbox.view);
}

/** Actions not yet on the server (the developer menu shows it). */
export function useWaitingCount(): number {
  return useSyncExternalStore(subscribe, () => outbox.size);
}

function tap(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

let promptedThisLaunch = false;

/** How the sign-up sheet is opened: pushed over the screen, or replacing a sheet. */
type Navigate = (href: '/sign-up') => void;

/**
 * The sign-up moment: a save while logged out makes a guest session (via the
 * outbox) and opens the sign-up sheet. Once there is a login, saves just save.
 */
function promptSignUp(navigate: Navigate): boolean {
  if (getMe() !== null || promptedThisLaunch) return false;
  promptedThisLaunch = true;
  navigate('/sign-up');
  return true;
}

/** A look's card from any cached list, or from a save still waiting on the phone. */
export function findCard(lookId: string): FeedCard | undefined {
  return findCachedCard(queryClient, lookId) ?? outbox.waitingCards().find((c) => c.id === lookId);
}

/**
 * Saves or unsaves a look (save button). Unsaving also takes it off every
 * board. The first save while logged out opens the sign-up sheet with
 * `navigate`; returns whether it did.
 */
export function setSaved(
  card: FeedCard,
  saved: boolean,
  navigate: Navigate = (href) => {
    router.push(href);
  },
): boolean {
  if (saved) {
    tap();
    outbox.add({ kind: 'save', lookId: card.id, card: { ...card, saved: true } });
    setSavedInLists(queryClient, card.id, true);
    return promptSignUp(navigate);
  }
  outbox.add({ kind: 'unsave', lookId: card.id });
  setSavedInLists(queryClient, card.id, false);
  removeFromLists(queryClient, [SAVES_QUERY_ROOT], card.id);
  removeFromLists(queryClient, [BOARD_LOOKS_QUERY_ROOT], card.id);
  return false;
}

/** Double-tap on a photo: only ever saves (like Instagram's double-tap like). */
export function saveIfNot(card: FeedCard): void {
  if (localSavedState(card.id) ?? card.saved) {
    tap();
    return;
  }
  void setSaved(card, true);
}

/** Puts the look on a board (which saves it too). The card, if known, shows in Saved meanwhile. */
export function addToBoard(lookId: string, boardId: string, card?: FeedCard): void {
  tap();
  outbox.add({
    kind: 'board-add',
    boardId,
    lookId,
    ...(card ? { card: { ...card, saved: true } } : {}),
  });
  setSavedInLists(queryClient, lookId, true);
}

/** Takes the look off one board; it stays saved. */
export function removeFromBoard(lookId: string, boardId: string): void {
  outbox.add({ kind: 'board-remove', boardId, lookId });
  removeFromLists(queryClient, boardLooksQueryKey(getActiveProfileId(), boardId), lookId);
}

/** "See less like this": the look leaves the cached feeds now, and For You learns from it. */
export function seeLess(lookId: string): void {
  outbox.add({ kind: 'see-less', lookId });
  removeFromLists(queryClient, [FEED_QUERY_ROOT], lookId);
}

/** Sends what is waiting before a sign-out, giving up after `ms` (offline). */
export async function sendWaiting(ms: number): Promise<void> {
  if (outbox.size === 0) return;
  await Promise.race([outbox.flush(), new Promise((resolve) => setTimeout(resolve, ms))]);
}
