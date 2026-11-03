import { feedCardSchema, type FeedCard } from '@outfitly/shared';
import { randomUUID } from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { z } from 'zod';
import { api } from '../api';
import { getActiveProfileId, getMe, subscribeMe } from '../auth/store';
import { findCachedCard } from '../feed/cache';
import { FEED_QUERY_ROOT } from '../feed/keys';
import { queryClient } from '../lib/query';
import { storage } from '../lib/storage';
import { realTimers } from '../lib/timers';
import { removeFromLists, setSavedInLists } from './cache';
import {
  BOARD_LOOKS_QUERY_ROOT,
  boardLooksQueryKey,
  BOARDS_QUERY_ROOT,
  SAVES_QUERY_ROOT,
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
  }
}

let startGuestSession: (() => Promise<unknown>) | null = null;

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
    // What the server has now: corrects any list that loaded while it was on its way.
    if (action.kind === 'save' || action.kind === 'board-add') {
      setSavedInLists(queryClient, action.lookId, true);
    } else if (action.kind === 'unsave') {
      setSavedInLists(queryClient, action.lookId, false);
    }
  },
  onDrained: () => {
    // Saves and boards loaded while actions were waiting may lack them.
    for (const root of [SAVES_QUERY_ROOT, BOARDS_QUERY_ROOT, BOARD_LOOKS_QUERY_ROOT]) {
      void queryClient.invalidateQueries({ queryKey: [root] });
    }
  },
});

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
  if (profileId) void outbox.flush();
});

const subscribe = (listener: () => void) => outbox.subscribe(listener);

/** Whether the look shows as saved: a waiting action wins over what the server said. */
export function useIsSaved(lookId: string, fromServer: boolean): boolean {
  return useSyncExternalStore(subscribe, () => outbox.savedState(lookId)) ?? fromServer;
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
function promptSignUp(navigate: Navigate): void {
  if (getMe() !== null || promptedThisLaunch) return;
  promptedThisLaunch = true;
  navigate('/sign-up');
}

/** A look's card from any cached list, or from a save still waiting on the phone. */
export function findCard(lookId: string): FeedCard | undefined {
  return findCachedCard(queryClient, lookId) ?? outbox.waitingCards().find((c) => c.id === lookId);
}

/**
 * Saves or unsaves a look (save button). Unsaving also takes it off every
 * board. The first save while logged out opens the sign-up sheet with `navigate`.
 */
export function setSaved(
  card: FeedCard,
  saved: boolean,
  navigate: Navigate = (href) => {
    router.push(href);
  },
): void {
  if (saved) {
    tap();
    outbox.add({ kind: 'save', lookId: card.id, card: { ...card, saved: true } });
    setSavedInLists(queryClient, card.id, true);
    promptSignUp(navigate);
    return;
  }
  outbox.add({ kind: 'unsave', lookId: card.id });
  setSavedInLists(queryClient, card.id, false);
  removeFromLists(queryClient, [SAVES_QUERY_ROOT], card.id);
  removeFromLists(queryClient, [BOARD_LOOKS_QUERY_ROOT], card.id);
}

/** Double-tap on a photo: only ever saves (like Instagram's double-tap like). */
export function saveIfNot(card: FeedCard): void {
  if (outbox.savedState(card.id) ?? card.saved) {
    tap();
    return;
  }
  setSaved(card, true);
}

/** Puts the look on a board (which saves it too). */
export function addToBoard(card: FeedCard, boardId: string): void {
  tap();
  outbox.add({ kind: 'board-add', boardId, lookId: card.id, card: { ...card, saved: true } });
  setSavedInLists(queryClient, card.id, true);
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
