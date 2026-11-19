import { useState, useEffect, useCallback } from 'react';
import { ThemeInit } from '@/lib/theme';
import { AppDirection } from '@/components/direction-provider';
import { FontSizeInit } from '@/lib/font-size';
import { OptionsNav, isValidNav, type NavItem } from './OptionsNav';
import { ModelSettings } from './ModelSettings';
import { UISettingsPage } from './UISettings';
import { ExecutionSettingsPage } from './ExecutionSettings';
import { McpSettings } from './McpSettings';
import { OcrSettingsPage } from './OcrSettings';
import { SystemPromptSettingsPage } from './SystemPromptSettings';
import { CommandSettingsPage } from './CommandSettings';
import { MentionSettingsPage } from './MentionSettings';
import { ChatDebugPage } from './ChatDebug';
import { FilesPage } from './files/FilesPage';
import { AboutPage } from './About';

/**
 * The hash may carry a sub-view: `#files/skills`.
 *
 * Only the first segment selects a page. Sub-views own the rest, so a page can
 * deep-link into its own state without the sidebar having to know about it — and
 * a hash it does not recognise still lands on that page rather than on the
 * default one.
 */
function getNavFromHash(): NavItem {
  const [base] = window.location.hash.replace('#', '').split('/');
  return isValidNav(base) ? base : 'models';
}

function useHashNav() {
  const [activeNav, setActiveNav] = useState<NavItem>(getNavFromHash);

  useEffect(() => {
    const onHashChange = () => {
      setActiveNav(getNavFromHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((nav: NavItem) => {
    window.location.hash = nav;
    setActiveNav(nav);
  }, []);

  return { activeNav, navigate };
}

export default function App() {
  const { activeNav, navigate } = useHashNav();

  return (
    <AppDirection>
    <div className="flex h-dvh w-full bg-background">
      <ThemeInit />
      <FontSizeInit />
      <OptionsNav activeNav={activeNav} onNavigate={navigate} />

      {/* Main Content */}
      <main className="flex-1 overflow-auto scrollbar-lumo p-4 lg:p-6 [scrollbar-gutter:stable]">
        {activeNav === 'models' && <ModelSettings />}
        {activeNav === 'ocr' && <OcrSettingsPage />}
        {activeNav === 'systemPrompt' && <SystemPromptSettingsPage />}
        {activeNav === 'commands' && <CommandSettingsPage />}
        {activeNav === 'mentions' && <MentionSettingsPage />}
        {activeNav === 'mcp' && <McpSettings />}
        {activeNav === 'files' && <FilesPage />}
        {activeNav === 'ui' && <UISettingsPage />}
        {activeNav === 'execution' && <ExecutionSettingsPage />}
        {activeNav === 'chatDebug' && <ChatDebugPage />}
        {activeNav === 'about' && <AboutPage />}
      </main>
    </div>
    </AppDirection>
  );
}
