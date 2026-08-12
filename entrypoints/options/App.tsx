import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Cpu,
  Palette,
  Plug,
  MessageSquareCode,
  Terminal,
  Bug,
  FolderOpen,
  Info,
} from 'lucide-react';
import { ThemeInit } from '@/lib/theme';
import { ModelSettings } from './ModelSettings';
import { UISettingsPage } from './UISettings';
import { McpSettings } from './McpSettings';
import { SystemPromptSettingsPage } from './SystemPromptSettings';
import { CommandSettingsPage } from './CommandSettings';
import { ChatDebugPage } from './ChatDebug';
import { FileManager } from './FileManager';
import { AboutPage } from './About';

const NAV_ITEMS = [
  'models',
  'systemPrompt',
  'commands',
  'mcp',
  'files',
  'ui',
  'chatDebug',
  'about',
] as const;
type NavItem = (typeof NAV_ITEMS)[number];

function isValidNav(hash: string): hash is NavItem {
  return (NAV_ITEMS as readonly string[]).includes(hash);
}

function getNavFromHash(): NavItem {
  const hash = window.location.hash.replace('#', '');
  return isValidNav(hash) ? hash : 'models';
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
  const { t } = useTranslation();
  const { activeNav, navigate } = useHashNav();

  return (
    <div className="flex h-screen w-full bg-background">
      <ThemeInit />
      {/* Left Navigation */}
      <nav className="w-56 shrink-0 border-r border-border bg-card flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="text-lg font-semibold text-foreground truncate">{t('options.title')}</h1>
        </div>
        <div className="flex-1 p-2 space-y-1">
          <NavButton
            active={activeNav === 'models'}
            onClick={() => navigate('models')}
            icon={<Cpu className="h-4 w-4" />}
            label={t('options.nav.models')}
          />
          <NavButton
            active={activeNav === 'systemPrompt'}
            onClick={() => navigate('systemPrompt')}
            icon={<MessageSquareCode className="h-4 w-4" />}
            label={t('options.nav.systemPrompt')}
          />
          <NavButton
            active={activeNav === 'commands'}
            onClick={() => navigate('commands')}
            icon={<Terminal className="h-4 w-4" />}
            label={t('options.nav.commands')}
          />
          <NavButton
            active={activeNav === 'mcp'}
            onClick={() => navigate('mcp')}
            icon={<Plug className="h-4 w-4" />}
            label={t('options.nav.mcp')}
          />
          <NavButton
            active={activeNav === 'files'}
            onClick={() => navigate('files')}
            icon={<FolderOpen className="h-4 w-4" />}
            label={t('options.nav.files')}
          />
          <NavButton
            active={activeNav === 'ui'}
            onClick={() => navigate('ui')}
            icon={<Palette className="h-4 w-4" />}
            label={t('options.nav.ui')}
          />
          <NavButton
            active={activeNav === 'chatDebug'}
            onClick={() => navigate('chatDebug')}
            icon={<Bug className="h-4 w-4" />}
            label={t('options.nav.chatDebug')}
          />
          <NavButton
            active={activeNav === 'about'}
            onClick={() => navigate('about')}
            icon={<Info className="h-4 w-4" />}
            label={t('options.nav.about')}
          />
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 overflow-auto scrollbar-lumo p-6">
        {activeNav === 'models' && <ModelSettings />}
        {activeNav === 'systemPrompt' && <SystemPromptSettingsPage />}
        {activeNav === 'commands' && <CommandSettingsPage />}
        {activeNav === 'mcp' && <McpSettings />}
        {activeNav === 'files' && <FileManager />}
        {activeNav === 'ui' && <UISettingsPage />}
        {activeNav === 'chatDebug' && <ChatDebugPage />}
        {activeNav === 'about' && <AboutPage />}
      </main>
    </div>
  );
}

function NavButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
        active
          ? 'bg-accent text-accent-foreground font-medium'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
