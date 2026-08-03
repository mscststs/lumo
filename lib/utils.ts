import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
