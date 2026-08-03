import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { AlertCircle, RotateCcw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  unknown: 'sidebar.error.unknownError',
};

export function ChatError({ error, isRetrying, retryAttempt, maxRetries, onRetry }: ChatErrorProps) {
  const { t } = useTranslation();

  const friendlyMessage = t(categoryToI18nKey[error.category]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="mx-2 my-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="flex-1 min-w-0 space-y-1.5">
          <p className="text-sm font-medium text-destructive">
            {t('sidebar.error.title')}
          </p>
          <p className="text-xs text-muted-foreground break-words">
            {friendlyMessage}
          </p>
          {/* Show raw error in a smaller, dimmer line for debugging */}
          {error.message && error.category !== 'unknown' && (
            <p className="text-[11px] text-muted-foreground/60 break-all line-clamp-2">
              {error.message}
            </p>
          )}
          {error.category === 'unknown' && (
            <p className="text-[11px] text-muted-foreground/60 break-all line-clamp-3">
              {error.message}
            </p>
          )}
        </div>
      </div>

      {/* Retry area */}
      <div className="mt-2.5 flex items-center justify-end gap-2">
        {isRetrying && (
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('sidebar.error.retrying', { current: retryAttempt, max: maxRetries })}
          </span>
        )}
        {/*
          Always offered, even for categories `isRetryableError` excludes: that
          flag only governs *automatic* retries. Once the user fixes the key or
          tops up credits, a manual retry resumes this conversation instead of
          forcing them to start a new one.
        */}
        {!isRetrying && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs gap-1.5 border-destructive/30 hover:bg-destructive/10"
            onClick={onRetry}
          >
            <RotateCcw className="h-3 w-3" />
            {t('sidebar.error.retry')}
          </Button>
        )}
      </div>
    </motion.div>
  );
}
