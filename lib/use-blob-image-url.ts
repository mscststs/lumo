import { useEffect, useState } from 'react';
import { resolveBlobUrl } from '@/lib/conversation-store';

/**
 * Resolution state of a blob-backed image.
 *
 * "Loading" and "gone" are deliberately distinct: collapsing them into a single
 * nullable URL made every expand flash a "screenshot unavailable" notice before
 * the bytes arrived, reporting a permanent failure for what was a normal read.
 */
export type BlobImageState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  /** The record referenced a blob that is no longer stored. */
  | { status: 'missing' }
  /** The read itself failed — retrying could still succeed. */
  | { status: 'error' };

/**
 * Resolve a `lumo-blob:` reference into a displayable object URL.
 *
 * Screenshots are stored as Blobs outside the conversation record, so they are
 * fetched only when a tool call is actually expanded — a conversation can hold
 * dozens of them and loading every one on open is exactly the cost this storage
 * layout exists to avoid.
 *
 * The object URL is revoked on unmount and whenever `ref` changes, so expanding
 * and collapsing calls repeatedly does not leak blob handles for the lifetime of
 * the panel.
 */
export function useBlobImageUrl(ref: string | undefined): BlobImageState {
  const [state, setState] = useState<BlobImageState>(
    ref ? { status: 'loading' } : { status: 'missing' },
  );

  useEffect(() => {
    if (!ref) {
      setState({ status: 'missing' });
      return;
    }

    let cancelled = false;
    let created: string | null = null;

    // Reset when switching references so a stale image is not shown under a new
    // one while its bytes load.
    setState({ status: 'loading' });

    void resolveBlobUrl(ref)
      .then((resolved) => {
        // Revoke immediately rather than storing it: the component is gone, so
        // nothing will ever render this URL.
        if (cancelled) {
          if (resolved) URL.revokeObjectURL(resolved);
          return;
        }
        if (!resolved) {
          setState({ status: 'missing' });
          return;
        }
        created = resolved;
        setState({ status: 'ready', url: resolved });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [ref]);

  return state;
}
