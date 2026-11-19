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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';

export const NAV_ITEMS = [
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
export type NavItem = (typeof NAV_ITEMS)[number];

export function isValidNav(hash: string | undefined): hash is NavItem {
  return typeof hash === 'string' && (NAV_ITEMS as readonly string[]).includes(hash);
}

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

/**
 * The breakpoint at which the navigation becomes an icon rail, spelled exactly
 * like Tailwind's `lg:` variant (64rem) that collapses it in CSS.
 *
 * Written with the Media Queries Level 4 range syntax so the two cannot
 * disagree at a fractional width: `(max-width: 63.99rem)` would leave a sliver
 * where the labels are already hidden but the rail tooltips have not started.
 */
const NAV_RAIL_QUERY = '(width < 64rem)';

interface OptionsNavProps {
  activeNav: NavItem;
  onNavigate: (item: NavItem) => void;
}

/**
 * The options page's left navigation.
 *
 * Below `lg` the same navigation is an icon rail rather than eating 224px of a
 * narrow window: the label column is what costs width, and the icons already
 * identify every entry. Nothing is removed — each item keeps its `aria-label`
 * and `aria-current` — so the page stays fully usable when the browser window is
 * dragged narrow.
 *
 * On that rail the label has to come back on demand. A hover tooltip is the
 * right surface for it — it is the control's own name, which is why the browser
 * default (`title`) was almost good enough — but `title` cannot be styled, its
 * delay is not ours, and it has no state for automation. It is also now removed
 * and replaced here rather than kept alongside: a native tooltip and a Radix
 * tooltip on the same element both appear, one over the other.
 *
 * The tooltip only exists while the rail does, decided by the same 64rem
 * breakpoint that hides the labels. Rendering it always would mean a second
 * copy of a label that is already visible on a wide window, and a disclosure
 * that promises something it does not change. Because it is a tooltip, it opens
 * on hover and keyboard focus and **not** on touch: a narrow touch window keeps
 * the `aria-label` and the icon, and the missing hover is the intended
 * behaviour, not a gap.
 */
export function OptionsNav({ activeNav, onNavigate }: OptionsNavProps) {
  const { t } = useTranslation();
  const isRail = useMediaQuery(NAV_RAIL_QUERY);

  return (
    <nav className="w-14 lg:w-56 shrink-0 border-e border-border bg-card flex flex-col">
      <div className="p-4 border-b border-border">
        <h1 className="text-lg font-semibold text-foreground truncate sr-only lg:not-sr-only">
          {t('options.title')}
        </h1>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="p-2">
          {/* One provider for the whole rail: sliding down the icons opens the
              next label instantly instead of restarting the 300ms wait on every
              button. `disableHoverableContent` because a one-line label has
              nothing to move into — see `components/ai-elements/message.tsx`. */}
          <TooltipProvider disableHoverableContent>
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
                      onClick={() => onNavigate(item)}
                      icon={NAV_ICONS[item]}
                      label={t(`options.nav.${item}`)}
                      rail={isRail}
                    />
                  ))}
                </div>
              </div>
            ))}
          </TooltipProvider>
        </div>
      </div>
    </nav>
  );
}

function NavButton({
  active,
  onClick,
  icon,
  label,
  rail,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  rail: boolean;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      // The current page is a fact about navigation, not only a colour: with the
      // label hidden on the icon rail, `aria-current` is the only thing telling a
      // screen reader which entry the user is on.
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      className={cn(
        'w-full flex items-center justify-center lg:justify-start gap-2 px-3 py-2 rounded-md text-sm transition-colors',
        active
          ? 'bg-accent text-accent-foreground font-medium'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {icon}
      <span className="hidden lg:inline truncate">{label}</span>
    </button>
  );

  if (!rail) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      {/* Opens toward the page, away from the window edge the rail sits on. */}
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
