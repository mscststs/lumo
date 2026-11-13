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
  ScanEye,
  Zap,
} from 'lucide-react';
import { ThemeInit } from '@/lib/theme';
import { AppDirection } from '@/components/direction-provider';
import { FontSizeInit } from '@/lib/font-size';
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

const NAV_ITEMS = [
  'models',
  'ocr',
  'systemPrompt',
  'commands',
  'mentions',
  'mcp',
  'files',
  'ui',
  'execution',
  'chatDebug',
  'about',
] as const;
type NavItem = (typeof NAV_ITEMS)[number];

const NAV_GROUPS: { titleKey?: string; items: NavItem[] }[] = [
  {
    titleKey: 'options.navGroups.core',
    items: ['models', 'ocr', 'mcp', 'files'],
  },
  {
    titleKey: 'options.navGroups.customization',
    items: ['ui', 'execution', 'systemPrompt', 'commands', 'mentions'],
  },
  {
    items: ['chatDebug', 'about'],
  },
];

const NAV_ICONS: Record<NavItem, React.ReactNode> = {
  models: <Cpu className="h-4 w-4" />,
  ocr: <ScanEye className="h-4 w-4" />,
  systemPrompt: <MessageSquareCode className="h-4 w-4" />,
  commands: <Terminal className="h-4 w-4" />,
  mentions: <AtSign className="h-4 w-4" />,
  mcp: <Plug className="h-4 w-4" />,
  files: <FolderOpen className="h-4 w-4" />,
  ui: <Palette className="h-4 w-4" />,
  execution: <Zap className="h-4 w-4" />,
  chatDebug: <Bug className="h-4 w-4" />,
  about: <Info className="h-4 w-4" />,
};

function isValidNav(hash: string | undefined): hash is NavItem {
  return typeof hash === 'string' && (NAV_ITEMS as readonly string[]).includes(hash);
}

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
  const { t } = useTranslation();
  const { activeNav, navigate } = useHashNav();

  return (
    <AppDirection>
    <div className="flex h-dvh w-full bg-background">
      <ThemeInit />
      <FontSizeInit />
      {/* Left Navigation.
          Below `lg` the same navigation becomes an icon rail rather than eating
          224px of a narrow window: the label column is what costs width, and the
          icons already identify every entry. Nothing is removed — each item keeps
          its `title`/`aria-label` — so the page stays fully usable when the
          browser window is dragged narrow. */}
      <nav className="w-14 lg:w-56 shrink-0 border-e border-border bg-card flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="text-lg font-semibold text-foreground truncate sr-only lg:not-sr-only">
            {t('options.title')}
          </h1>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="p-2">
            {NAV_GROUPS.map((group, gi) => (
              <div
                key={group.titleKey ?? group.items[0]}
                className={gi > 0 ? 'mt-3 pt-3 border-t border-border' : ''}
              >
                {group.titleKey && (
                  <p className="hidden lg:block px-3 pb-1.5 text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground truncate select-none">
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
      type="button"
      onClick={onClick}
      // The current page is a fact about navigation, not only a colour: with the
      // label hidden on the icon rail, `aria-current` is the only thing telling a
      // screen reader which entry the user is on.
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      title={label}
      className={`w-full flex items-center justify-center lg:justify-start gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
        active
          ? 'bg-accent text-accent-foreground font-medium'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      }`}
    >
      {icon}
      <span className="hidden lg:inline truncate">{label}</span>
    </button>
  );
}
