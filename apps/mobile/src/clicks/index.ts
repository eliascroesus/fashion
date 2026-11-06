// Loaded by the root layout, so clicks waiting on the phone are sent as soon as the app
// starts, not only once a look is opened (routes load lazily in release builds).
import type { ClientClick } from '@outfitly/shared';
import { randomUUID } from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { AppState, Platform } from 'react-native';
import { api } from '../api';
import { sessionId } from '../events';
import { EventQueue } from '../events/queue';
import { Sentry } from '../lib/sentry';
import { storage } from '../lib/storage';
import { realTimers } from '../lib/timers';
import { CLICK_RULES, createShopOpener, readStoredClicks } from './shop';

export { NO_ORIGIN, originFromParams, originParams, type LookOrigin } from './shop';

const QUEUE_KEY = 'clicks.queue';

const queue = new EventQueue<ClientClick>({
  load: () => readStoredClicks(storage.getString(QUEUE_KEY)),
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
  onDropped: (count) => {
    Sentry.addBreadcrumb({
      category: 'clicks',
      level: 'warning',
      message: `Dropped the ${String(count)} oldest unsent clicks (phone queue full)`,
    });
  },
});

// Send what waits before the phone may suspend the app, and when it's back.
AppState.addEventListener('change', (state) => {
  if (state === 'background' || state === 'active') void queue.flush();
});

/**
 * Android: the browser that shows Custom Tabs, asked for by name. A link
 * handed to Android without one goes to the shop's own app when it's
 * installed and claims the shop's links; naming the browser is what keeps it
 * in the browser. (Warming the browser up only makes the tab open faster:
 * expo-web-browser builds the tab without the warmed-up session, so Chrome's
 * own rules on handing links to apps still apply; check on a real phone.)
 * The browser is never asked to load a link ahead: that would count as a
 * visit on the poster's affiliate link. With no Custom Tabs browser, the link
 * goes to Android as is (and may open the shop's app).
 */
let browserPackage: Promise<string | undefined> | null = null;
function customTabsBrowser(): Promise<string | undefined> {
  browserPackage ??= WebBrowser.getCustomTabsSupportingBrowsersAsync()
    .then(async (found) => {
      const name =
        found.preferredBrowserPackage ?? found.defaultBrowserPackage ?? found.browserPackages[0];
      if (!name) {
        browserPackage = null; // ask again next time (e.g. a browser was installed meanwhile)
        return undefined;
      }
      await WebBrowser.warmUpAsync(name).catch(() => undefined);
      return name;
    })
    .catch(() => {
      browserPackage = null;
      return undefined;
    });
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
  now: Date.now,
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
    try {
      await WebBrowser.openBrowserAsync(url, options);
    } catch (error) {
      browserPackage = null; // the named browser may be gone: look again next time
      throw error;
    }
    // Back from the shop (iPhone): send the click now if it's still waiting.
    void queue.flush();
  },
  report: (error) => {
    Sentry.captureException(error);
  },
});
