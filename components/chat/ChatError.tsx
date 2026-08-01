import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { AlertCircle, RotateCcw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ChatErrorInfo {
  /** Original error message from the API/network */
  message: string;
  /** Classified error category for user-friendly display */
  category: 'network' | 'auth' | 'rateLimit' | 'server' | 'timeout' | 'unknown';
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
 * Classifies a raw Error into a user-facing error category.
 */
export function classifyError(error: Error): ChatErrorInfo {
  const msg = error.message.toLowerCase();

  if (
    msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('failed to fetch') ||
    msg.includes('net::') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound')
  ) {
    return { message: error.message, category: 'network' };
  }

  if (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('authentication')
  ) {
    return { message: error.message, category: 'auth' };
  }

  if (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests') ||
    msg.includes('quota')
  ) {
    return { message: error.message, category: 'rateLimit' };
  }

  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('deadline')
  ) {
    return { message: error.message, category: 'timeout' };
  }

  if (
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('internal server error') ||
    msg.includes('service unavailable') ||
    msg.includes('bad gateway') ||
    msg.includes('overloaded')
  ) {
    return { message: error.message, category: 'server' };
  }

  return { message: error.message, category: 'unknown' };
}

/**
 * Whether this error category is safe to auto-retry.
 * Auth errors should NOT be retried automatically.
 */
export function isRetryableError(category: ChatErrorInfo['category']): boolean {
  return category !== 'auth';
}

const categoryToI18nKey: Record<ChatErrorInfo['category'], string> = {
  network: 'sidebar.error.networkError',
  auth: 'sidebar.error.authError',
  rateLimit: 'sidebar.error.rateLimitError',
  server: 'sidebar.error.serverError',
  timeout: 'sidebar.error.timeoutError',
  unknown: 'sidebar.error.unknownError',
};

export function ChatError({ error, isRetrying, retryAttempt, maxRetries, onRetry }: ChatErrorProps) {
  const { t } = useTranslation();

  const friendlyMessage = t(categoryToI18nKey[error.category]);
  const canRetry = isRetryableError(error.category);

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
        {!isRetrying && canRetry && (
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
