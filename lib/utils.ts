import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a byte count for display, in binary units.
 *
 * Shared rather than per-view: the file manager and the about page report the
 * same numbers (a file's size is part of both totals), and two formatters would
 * eventually disagree on rounding.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Detects macOS-like platforms (including iOS).
 * Used to decide whether the "Meta" modifier renders/behaves as ⌘ (macOS)
 * or Ctrl (Windows / Linux), where the physical Meta/Windows key is
 * typically intercepted by the OS and unavailable to web pages.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent ?? '';
  const platform = navigator.platform ?? '';
  return /Mac|iPhone|iPad|iPod/.test(ua) || /Mac/.test(platform);
}
