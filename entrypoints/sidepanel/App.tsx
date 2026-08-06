import { ThemeInit } from '@/lib/theme';
import { SplitView } from '@/components/chat/SplitView';

/**
 * Sidepanel root — sets up theme and hands the chat UI to SplitView.
 *
 * Quick actions from the right-click menu are consumed by SplitView itself (via
 * `useContextMenuPending`), because choosing which panel handles an action
 * requires reading every panel's live state — knowledge that only SplitView has.
 */
export default function App() {
  return (
    <div className="h-screen w-full bg-background overflow-hidden">
      <ThemeInit />
      <SplitView />
    </div>
  );
}
