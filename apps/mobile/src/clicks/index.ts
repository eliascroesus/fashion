import { type ClientClick, clientClickSchema } from '@outfitly/shared';
import { randomUUID } from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { AppState, Platform } from 'react-native';
import { z } from 'zod';
import { api } from '../api';
import { sessionId } from '../events';
import { EventQueue } from '../events/queue';
import { Sentry } from '../lib/sentry';
import { storage } from '../lib/storage';
import { realTimers } from '../lib/timers';
import { CLICK_RULES, createShopOpener } from './shop';

export { NO_ORIGIN, originFromParams, originParams, type LookOrigin } from './shop';

const QUEUE_KEY = 'clicks.queue';

function loadQueue(): ClientClick[] {
  try {
    // An older app version may have stored another shape: start empty then.
    const parsed = z
      .array(clientClickSchema)
      .safeParse(JSON.parse(storage.getString(QUEUE_KEY) ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const queue = new EventQueue<ClientClick>({
  load: loadQueue,
  save: (clicks) => {
    storage.set(QUEUE_KEY, JSON.stringify(clicks));
  },
  send: async (clicks, idempotencyKey) => {
    await api.clicks.send(
      { sessionId: sessionId(), platform: Platform.OS === 'ios' ? 'ios' : 'android', clicks },
      idempotencyKey,
    );
  },
  newKey: randomUUID,
  timers: realTimers,
  rules: CLICK_RULES,
});

// Send what waits before the phone may suspend the app, and when it's back.
AppState.addEventListener('change', (state) => {
  if (state === 'background' || state === 'active') void queue.flush();
});

/**
 * Android: the browser that shows Custom Tabs, asked for by name. A link
 * handed to Android without one goes to the shop's own app when it's
 * installed and claims the shop's links; named, it stays in the browser.
 * The browser is also warmed up (a Custom Tabs connection, which per Chrome's
 * docs keeps links in the tab), but never asked to load a link ahead: that
 * would count as a visit on the poster's affiliate link.
 */
let browserPackage: Promise<string | undefined> | null = null;
function customTabsBrowser(): Promise<string | undefined> {
  browserPackage ??= WebBrowser.getCustomTabsSupportingBrowsersAsync()
    .then(async (found) => {
      const name =
        found.preferredBrowserPackage ?? found.defaultBrowserPackage ?? found.browserPackages[0];
      if (name) await WebBrowser.warmUpAsync(name).catch(() => undefined);
      return name;
    })
    .catch(() => undefined);
  return browserPackage;
}

/** Android: get the browser ready while the look page shows its pieces. */
export function prepareShop(): void {
  if (Platform.OS === 'android') void customTabsBrowser();
}

/** The in-app browser's colours, from the app's theme. */
export interface ShopStyle {
  bar: string;
  controls: string;
}

/**
 * Opens a piece's shop in the in-app browser (Safari view on iPhone, Chrome
 * Custom Tab on Android), never the shop's own app, after keeping the click
 * on the phone. See createShopOpener.
 */
export const openShop = createShopOpener<ShopStyle>({
  newId: randomUUID,
  keep: (click) => {
    queue.add(click);
  },
  open: async (url, style) => {
    const options: WebBrowser.WebBrowserOpenOptions = {
      toolbarColor: style.bar,
      controlsColor: style.controls,
      dismissButtonStyle: 'done',
      enableBarCollapsing: true,
      showTitle: true,
    };
    if (Platform.OS === 'android') options.browserPackage = await customTabsBrowser();
    await WebBrowser.openBrowserAsync(url, options);
    // Back from the shop (iPhone): send the click now if it's still waiting.
    void queue.flush();
  },
  report: (error) => {
    Sentry.captureException(error);
  },
});
