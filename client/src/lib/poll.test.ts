import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pollWhileVisible, type Visibility } from "./poll";

function fakeVisibility(initiallyVisible = true) {
  let visible = initiallyVisible;
  const listeners = new Set<() => void>();
  const visibility: Visibility = {
    visible: () => visible,
    onVisible: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    visibility,
    hide: () => {
      visible = false;
    },
    show: () => {
      visible = true;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

/* Laisse s'écouler les promesses déjà résolues (la relecture est asynchrone). */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("relire tant que l'onglet est visible", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("relit à chaque intervalle, et s'arrête quand on le lui dit", async () => {
    const run = vi.fn(() => Promise.resolve());
    const { visibility, listeners } = fakeVisibility();
    const stop = pollWhileVisible(run, 3_000, visibility);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(listeners.size).toBe(0);
  });

  it("onglet caché : aucune requête ; au retour, une relecture immédiate", async () => {
    const run = vi.fn(() => Promise.resolve());
    const tab = fakeVisibility();
    const stop = pollWhileVisible(run, 3_000, tab.visibility);
    tab.hide();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).not.toHaveBeenCalled();
    tab.show();
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it("une relecture lente n'en empile pas d'autres, et un échec n'arrête rien", async () => {
    let release!: () => void;
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((done) => (release = done)))
      .mockImplementationOnce(() => Promise.reject(new Error("serveur injoignable")))
      .mockImplementation(() => Promise.resolve());
    const stop = pollWhileVisible(run, 3_000, fakeVisibility().visibility);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await settle();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
  });
});
