import { useEffect } from 'react';
import { ThemeInit } from '@/lib/theme';
import { FontSizeInit } from '@/lib/font-size';
import { emitEvent } from '@/lib/event-bus';
import { SplitView } from '@/components/chat/SplitView';

/**
 * Sidepanel root — sets up theme and hands the chat UI to SplitView.
 *
 * Quick actions from the right-click menu are consumed by SplitView itself (via
 * `useContextMenuPending`), because choosing which panel handles an action
 * requires reading every panel's live state — knowledge that only SplitView has.
 *
 * The panel is the only context that knows its own liveness, so it announces
 * open/close over the event bus. Consumers (e.g. the options page's drag
 * affordance) otherwise could only infer it from focus events, which are not
 * fired the moment the panel opens.
 */
export default function App() {
  useEffect(() => {
    let closed = false;
    emitEvent('sidepanel:opened', {});

    const announceClosed = () => {
      if (closed) return;
      closed = true;
      emitEvent('sidepanel:closed', {});
    };
    // `pagehide` is the last reliable moment the document is still alive; the
    // `beforeunload` guard makes the pair idempotent.
    window.addEventListener('pagehide', announceClosed);
    window.addEventListener('beforeunload', announceClosed);
    return () => {
      window.removeEventListener('pagehide', announceClosed);
      window.removeEventListener('beforeunload', announceClosed);
    };
  }, []);

  return (
    <div className="h-screen w-full bg-background overflow-hidden">
      <ThemeInit />
      <FontSizeInit />
      <SplitView />
    </div>
  );
}
