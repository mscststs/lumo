import { useEffect, useRef, useCallback } from 'react';
import type { StorageKey } from './storage-schema';

export type { StorageKey };

type StorageChangeCallback<T = unknown> = (newValue: T | undefined, oldValue: T | undefined) => void;

/**
 * Hook that watches for chrome.storage.local changes on specified keys.
 * When the options page (or any other context) updates storage,
 * this hook fires the callback in real time.
 */
export function useStorageWatch<T = unknown>(
  key: StorageKey,
  callback: StorageChangeCallback<T>,
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      if (key in changes) {
        const change = changes[key]!;
        callbackRef.current(change.newValue as T | undefined, change.oldValue as T | undefined);
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => {
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [key]);
}

/**
 * Hook that watches multiple storage keys at once.
 * The callback receives the key that changed along with new/old values.
 */
export function useStorageWatchMultiple(
  keys: StorageKey[],
  callback: (key: StorageKey, newValue: unknown, oldValue: unknown) => void,
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const keysRef = useRef(keys);
  keysRef.current = keys;

  useEffect(() => {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      for (const key of keysRef.current) {
        if (key in changes) {
          const change = changes[key]!;
          callbackRef.current(key, change.newValue, change.oldValue);
        }
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => {
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);
}
