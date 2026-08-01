import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu, Palette, Plug, MessageSquareCode, Bug } from 'lucide-react';
import { ThemeInit } from '@/lib/theme';
import { ModelSettings } from './ModelSettings';
import { UISettingsPage } from './UISettings';
import { McpSettings } from './McpSettings';
import { SystemPromptSettingsPage } from './SystemPromptSettings';
import { ChatDebugPage } from './ChatDebug';

type NavItem = 'models' | 'systemPrompt' | 'ui' | 'mcp' | 'chatDebug';

export default function App() {
  const { t } = useTranslation();
  const [activeNav, setActiveNav] = useState<NavItem>('models');

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
            onClick={() => setActiveNav('models')}
            icon={<Cpu className="h-4 w-4" />}
            label={t('options.nav.models')}
          />
          <NavButton
            active={activeNav === 'systemPrompt'}
            onClick={() => setActiveNav('systemPrompt')}
            icon={<MessageSquareCode className="h-4 w-4" />}
            label={t('options.nav.systemPrompt')}
          />
          <NavButton
            active={activeNav === 'mcp'}
            onClick={() => setActiveNav('mcp')}
            icon={<Plug className="h-4 w-4" />}
            label={t('options.nav.mcp')}
          />
          <NavButton
            active={activeNav === 'ui'}
            onClick={() => setActiveNav('ui')}
            icon={<Palette className="h-4 w-4" />}
            label={t('options.nav.ui')}
          />
          <NavButton
            active={activeNav === 'chatDebug'}
            onClick={() => setActiveNav('chatDebug')}
            icon={<Bug className="h-4 w-4" />}
            label={t('options.nav.chatDebug')}
          />
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 overflow-auto scrollbar-lumo p-6">
        {activeNav === 'models' && <ModelSettings />}
        {activeNav === 'systemPrompt' && <SystemPromptSettingsPage />}
        {activeNav === 'mcp' && <McpSettings />}
        {activeNav === 'ui' && <UISettingsPage />}
        {activeNav === 'chatDebug' && <ChatDebugPage />}
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
