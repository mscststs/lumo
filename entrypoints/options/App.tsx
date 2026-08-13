import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Cpu,
  Palette,
  Plug,
  MessageSquareCode,
  Terminal,
  AtSign,
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
import { MentionSettingsPage } from './MentionSettings';
import { ChatDebugPage } from './ChatDebug';
import { FileManager } from './FileManager';
import { AboutPage } from './About';

const NAV_ITEMS = [
  'models',
  'systemPrompt',
  'commands',
  'mentions',
  'mcp',
  'files',
  'ui',
  'chatDebug',
  'about',
] as const;
type NavItem = (typeof NAV_ITEMS)[number];

const NAV_GROUPS: { titleKey?: string; items: NavItem[] }[] = [
  {
    titleKey: 'options.navGroups.core',
    items: ['models', 'mcp', 'files'],
  },
  {
    titleKey: 'options.navGroups.customization',
    items: ['ui', 'systemPrompt', 'commands', 'mentions'],
  },
  {
    items: ['chatDebug', 'about'],
  },
];

const NAV_ICONS: Record<NavItem, React.ReactNode> = {
  models: <Cpu className="h-4 w-4" />,
  systemPrompt: <MessageSquareCode className="h-4 w-4" />,
  commands: <Terminal className="h-4 w-4" />,
  mentions: <AtSign className="h-4 w-4" />,
  mcp: <Plug className="h-4 w-4" />,
  files: <FolderOpen className="h-4 w-4" />,
  ui: <Palette className="h-4 w-4" />,
  chatDebug: <Bug className="h-4 w-4" />,
  about: <Info className="h-4 w-4" />,
};

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
        <div className="flex-1 overflow-y-auto">
          <div className="p-2">
            {NAV_GROUPS.map((group, gi) => (
              <div
                key={group.titleKey ?? group.items[0]}
                className={gi > 0 ? 'mt-3 pt-3 border-t border-border' : ''}
              >
                {group.titleKey && (
                  <p className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground truncate select-none">
                    {t(group.titleKey)}
                  </p>
                )}
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <NavButton
                      key={item}
                      active={activeNav === item}
                      onClick={() => navigate(item)}
                      icon={NAV_ICONS[item]}
                      label={t(`options.nav.${item}`)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 overflow-auto scrollbar-lumo p-6">
        {activeNav === 'models' && <ModelSettings />}
        {activeNav === 'systemPrompt' && <SystemPromptSettingsPage />}
        {activeNav === 'commands' && <CommandSettingsPage />}
        {activeNav === 'mentions' && <MentionSettingsPage />}
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
