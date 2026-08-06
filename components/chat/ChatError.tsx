import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { AlertCircle, RotateCcw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { categorizeError, isRetryableCategory } from '@/lib/provider-error';
import type { ChatErrorCategory } from '@/lib/provider-error';

export interface ChatErrorInfo {
  /** Original error message from the API/network */
  message: string;
  /** Classified error category for user-friendly display */
  category: ChatErrorCategory;
}

interface ChatErrorProps {
  error: ChatErrorInfo;
  /** Whether an automatic retry is in progress */
  isRetrying: boolean;
  /** Current retry attempt (1-based) */
  retryAttempt: number;
  /** Max retry attempts */
  maxRetries: number;
  /** Callback to manually trigger a retry */
  onRetry: () => void;
}

/**
 * Classify a raw Error into a user-facing category.
 *
 * Thin wrapper over `categorizeError`, which prefers the provider's own code and
 * HTTP status over matching on the message text.
 */
export function classifyError(error: Error): ChatErrorInfo {
  return { message: error.message, category: categorizeError(error) };
}

/**
 * Whether this error category is safe to auto-retry.
 *
 * Auth and quota failures are deterministic: retrying burns the backoff delay
 * and hits the same wall, so they surface immediately instead.
 */
export function isRetryableError(category: ChatErrorCategory): boolean {
  return isRetryableCategory(category);
}

const categoryToI18nKey: Record<ChatErrorCategory, string> = {
  network: 'sidebar.error.networkError',
  auth: 'sidebar.error.authError',
  quota: 'sidebar.error.quotaError',
  rateLimit: 'sidebar.error.rateLimitError',
  server: 'sidebar.error.serverError',
  timeout: 'sidebar.error.timeoutError',
  storage: 'sidebar.error.storageError',
  unknown: 'sidebar.error.unknownError',
};

export function ChatError({ error, isRetrying, retryAttempt, maxRetries, onRetry }: ChatErrorProps) {
  const { t } = useTranslation();

  const friendlyMessage = t(categoryToI18nKey[error.category]);
  // The friendly copy for `unknown` says nothing actionable, so the raw text is
  // the only signal the user has — give it more room in that case.
  const rawClamp = error.category === 'unknown' ? 'line-clamp-3' : 'line-clamp-2';

  // A storage failure is not a failed request: the model already replied and the
  // reply is on screen, only saving it failed. Calling that "Request Failed"
  // would be wrong, and offering a retry would re-run the model call and append a
  // duplicate turn, so the card becomes a plain warning instead.
  const isPersistenceFailure = error.category === 'storage';
  const title = isPersistenceFailure ? t('sidebar.error.storageTitle') : t('sidebar.error.title');

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      // No horizontal margin: ConversationContent already pads the column, and
      // insetting further would misalign this card against every message bubble.
      className="w-full min-w-0 overflow-hidden rounded-lg border border-destructive/25 bg-destructive/5"
    >
      <div className="flex items-start gap-2 p-2.5">
        <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[0.8125rem] font-semibold leading-4 text-destructive">
            {title}
          </p>
          <p className="text-xs leading-relaxed text-foreground/80 break-words">
            {friendlyMessage}
          </p>
        </div>
      </div>

      {/* Raw provider text, sunk into its own block so it reads as a technical
          detail instead of washed-out prose. Nesting the same tint deepens it
          against the card without a second hard-coded colour. */}
      {error.message && (
        <div className="border-t border-destructive/15 bg-destructive/5 px-2.5 py-1.5">
          <p
            className={cn(
              'font-mono text-[0.6875rem] leading-relaxed text-muted-foreground break-all',
              rawClamp,
            )}
          >
            {error.message}
          </p>
        </div>
      )}

      {/* Retry area */}
      {!isPersistenceFailure && (
        <div className="flex items-center justify-end gap-2 border-t border-destructive/15 px-2.5 py-1.5">
          {isRetrying ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              <span className="truncate">
                {t('sidebar.error.retrying', { current: retryAttempt, max: maxRetries })}
              </span>
            </span>
          ) : (
            /*
              Always offered, even for categories `isRetryableError` excludes: that
              flag only governs *automatic* retries. Once the user fixes the key or
              tops up credits, a manual retry resumes this conversation instead of
              forcing them to start a new one.
            */
            <Button
              variant="outline"
              size="sm"
              // `bg-transparent` is required: the outline variant's `bg-background`
              // would punch an opaque hole through the card's tint.
              className="h-6 gap-1.5 border-destructive/30 bg-transparent px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onRetry}
            >
              <RotateCcw className="h-3 w-3 shrink-0" />
              <span className="truncate">{t('sidebar.error.retry')}</span>
            </Button>
          )}
        </div>
      )}
    </motion.div>
  );
}
