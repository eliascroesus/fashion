import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMPRESSION_MS, ImpressionTracker, type VisibleCard } from './impressions';

let counted: VisibleCard[];
let tracker: ImpressionTracker;

beforeEach(() => {
  vi.useFakeTimers();
  counted = [];
  tracker = new ImpressionTracker((card) => counted.push(card));
});

afterEach(() => {
  tracker.dispose();
  vi.useRealTimers();
});

const a = { lookId: 'a', position: 0 };
const b = { lookId: 'b', position: 1 };

describe('ImpressionTracker', () => {
  it('counts a card after a second on screen, with its place in the feed', () => {
    tracker.update([a, b]);
    vi.advanceTimersByTime(IMPRESSION_MS - 1);
    expect(counted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(counted).toEqual([a, b]);
  });

  it('does not count a card that left the screen before the second was up', () => {
    tracker.update([a]);
    vi.advanceTimersByTime(600);
    tracker.update([]);
    vi.advanceTimersByTime(600);
    tracker.update([a]);
    vi.advanceTimersByTime(600);
    expect(counted).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(counted).toEqual([a]);
  });

  it('counts each card once per list, until the list is refreshed', () => {
    tracker.update([a]);
    vi.advanceTimersByTime(IMPRESSION_MS);
    tracker.update([]);
    tracker.update([a]);
    vi.advanceTimersByTime(IMPRESSION_MS * 3);
    expect(counted).toHaveLength(1);

    tracker.reset();
    tracker.update([{ lookId: 'a', position: 4 }]);
    vi.advanceTimersByTime(IMPRESSION_MS);
    expect(counted).toEqual([a, { lookId: 'a', position: 4 }]);
  });

  it('pauses while the feed is hidden, and restarts the clock when it is back', () => {
    tracker.update([a]);
    vi.advanceTimersByTime(900);
    tracker.setActive(false);
    vi.advanceTimersByTime(5000);
    expect(counted).toEqual([]);
    tracker.setActive(true);
    vi.advanceTimersByTime(900);
    expect(counted).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(counted).toEqual([a]);
  });

  it('starts nothing for cards that appear while paused, until it is active again', () => {
    tracker.setActive(false);
    tracker.update([b]);
    vi.advanceTimersByTime(IMPRESSION_MS * 2);
    expect(counted).toEqual([]);
    tracker.setActive(true);
    vi.advanceTimersByTime(IMPRESSION_MS);
    expect(counted).toEqual([b]);
  });
});
