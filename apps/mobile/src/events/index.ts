import { type ClientEvent, clientEventSchema, type EventSource } from '@outfitly/shared';
import { randomUUID } from 'expo-crypto';
import { AppState, Platform } from 'react-native';
import { z } from 'zod';
import { api } from '../api';
import { storage } from '../lib/storage';
import { realTimers } from '../lib/timers';
import { EventQueue } from './queue';

const QUEUE_KEY = 'events.queue';
const SESSION_KEY = 'events.sessionId';

/**
 * A random id for this app install, sent with events so logged-out browsing
 * can be counted without an account. It identifies nothing but the install.
 */
function sessionId(): string {
  let id = storage.getString(SESSION_KEY);
  if (!id) {
    id = randomUUID();
    storage.set(SESSION_KEY, id);
  }
  return id;
}

function loadQueue(): ClientEvent[] {
  try {
    // An older app version may have stored another shape: start empty then.
    const parsed = z
      .array(clientEventSchema)
      .safeParse(JSON.parse(storage.getString(QUEUE_KEY) ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const queue = new EventQueue({
  load: loadQueue,
  save: (events) => {
    storage.set(QUEUE_KEY, JSON.stringify(events));
  },
  send: async (events, idempotencyKey) => {
    await api.events.send(
      { sessionId: sessionId(), platform: Platform.OS === 'ios' ? 'ios' : 'android', events },
      idempotencyKey,
    );
  },
  newKey: randomUUID,
  timers: realTimers,
});

// Send what is waiting before the phone may suspend the app.
AppState.addEventListener('change', (state) => {
  if (state === 'background') void queue.flush();
});

/** A feed card was at least half on screen for a second. */
export function logImpression(lookId: string, position: number, source: EventSource): void {
  queue.add({
    id: randomUUID(),
    name: 'impression',
    lookId,
    position,
    source,
    occurredAt: new Date().toISOString(),
  });
}
