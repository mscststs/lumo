import { tool } from 'ai';
import { z } from 'zod';
import type {
  IMcpServer,
  McpServerInfo,
  McpServerStatus,
  McpToolDefinition,
  McpToolExecutionContext,
  AnyTool,
} from './types';
import { fileStorage, getPreviewCategory, isLikelyTextContent } from './file-storage';
import { downloadAsZip } from '@/lib/zip-download';
import { applyEdits, applyUnifiedDiff } from './file-edit';
import { applyOutputLimit, DEFAULT_MAX_CHARS } from '@/lib/page/output-limit';

/**
 * Render a tool's zod schema as JSON Schema for the settings UI.
 *
 * Mirrors `page-interact-server.ts`: a tool list is a display concern, so a
 * schema `z.toJSONSchema` cannot represent degrades to a bare object rather
 * than breaking the options page.
 */
function toJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  try {
    const json = z.toJSONSchema(schema as z.ZodType, { io: 'input' }) as Record<string, unknown>;
    delete json.$schema;
    return json;
  } catch {
    return { type: 'object', properties: {} };
  }
}

/** Preview URL for a file, or undefined when its type cannot be previewed. */
function previewUrlFor(name: string, mimeType: string): string | undefined {
  if (getPreviewCategory(mimeType) === 'unsupported') return undefined;
  return chrome.runtime.getURL(`/preview.html?file=${encodeURIComponent(name)}`);
}

/**
 * Built-in File MCP Server.
 * Provides tools for reading, writing, patching and previewing files
 * stored in the extension's IndexedDB.
 */
export class FileMcpServer implements IMcpServer {
  private status: McpServerStatus = 'disconnected';
  private error?: string;

  getInfo(): McpServerInfo {
    return {
      id: 'file',
      name: 'File Manager',
      description: 'Read, write, edit, and preview files stored in the extension',
      transport: 'builtin',
      builtin: true,
      enabled: true,
      icon: 'file',
    };
  }

  async connect(): Promise<void> {
    try {
      this.status = 'connecting';
      // Verify IndexedDB is available
      if (typeof indexedDB === 'undefined') {
        throw new Error('IndexedDB is not available');
      }
      this.status = 'connected';
      this.error = undefined;
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected';
  }

  getStatus(): McpServerStatus {
    return this.status;
  }

  getError(): string | undefined {
    return this.error;
  }

  /**
   * UI-facing tool list, derived from the same zod schemas the model sees.
   *
   * This was a hand-written JSON Schema array that had already drifted from
   * `getAITools()` (`file_read`'s two descriptions disagreed). Deriving it
   * removes the class of bug instead of fixing one instance.
   */
  getTools(): McpToolDefinition[] {
    return Object.entries(this.getAITools()).map(([name, definition]) => ({
      name,
      description: (definition as { description?: string }).description ?? '',
      inputSchema: toJsonSchema((definition as { inputSchema?: unknown }).inputSchema),
    }));
  }

  getAITools(context?: McpToolExecutionContext): Record<string, AnyTool> {
    const conversationId = context?.conversationId;

    return {
      file_read: tool({
        description:
          'Read a text file stored in the extension. Always read a file before editing it, ' +
          'and copy anchor text for file_edit from this output rather than from memory. ' +
          'If the result reports truncated: true, call again with offset to continue.',
        inputSchema: z.object({
          name: z.string().describe('File name to read'),
          maxChars: z
            .number()
            .optional()
            .describe(`Max characters to return (default ${DEFAULT_MAX_CHARS})`),
          offset: z
            .number()
            .optional()
            .describe('Character offset, for paging through a long file'),
        }),
        execute: async ({ name, maxChars, offset }) => {
          const content = await fileStorage.readFileAsText(name);
          if (content === null) {
            return { error: `File "${name}" not found` };
          }
          const metadata = await fileStorage.getMetadata(name);
          const limited = applyOutputLimit(content, { maxChars, offset });
          return {
            name,
            mimeType: metadata?.mimeType,
            size: metadata?.size,
            content: limited.text,
            limit: limited.limit,
          };
        },
      }),

      file_write: tool({
        description:
          'Write or create a file in the extension storage. This OVERWRITES the whole file, ' +
          'so use file_edit to change part of an existing file. Returns the file metadata and ' +
          'a preview URL on success.',
        inputSchema: z.object({
          name: z.string().describe('File name (e.g. "notes.md", "data.json", "script.py")'),
          content: z.string().describe('File content to write'),
        }),
        execute: async ({ name, content: fileContent }) => {
          const metadata = await fileStorage.writeFile(name, fileContent, { conversationId });

          return {
            success: true,
            name: metadata.name,
            mimeType: metadata.mimeType,
            size: metadata.size,
            createdAt: metadata.createdAt,
            updatedAt: metadata.updatedAt,
            previewUrl: previewUrlFor(metadata.name, metadata.mimeType),
          };
        },
      }),

      file_edit: tool({
        description:
          'Edit an existing text file by replacing exact text. This is the preferred way to ' +
          'modify a file: it needs no diff syntax and no line numbers. Each edit replaces ' +
          'oldText with newText. oldText must appear EXACTLY ONCE in the file — include ' +
          'enough surrounding lines to make it unique — and must be copied verbatim from ' +
          'file_read, including indentation. Pass several edits to apply them in order; if ' +
          'any one fails, none are written and the file is left untouched.',
        inputSchema: z.object({
          name: z.string().describe('File name to edit'),
          edits: z
            .array(
              z.object({
                oldText: z
                  .string()
                  .describe('Exact text to find, copied verbatim from the file. Must be unique.'),
                newText: z.string().describe('Replacement text. Use "" to delete the matched text.'),
              }),
            )
            .min(1)
            .describe('Replacements to apply in order'),
        }),
        execute: async ({ name, edits }) => {
          const original = await fileStorage.readFileAsText(name);
          if (original === null) {
            return { error: `File "${name}" not found. Use file_write to create it.` };
          }

          const result = applyEdits(original, edits);
          if (!result.ok) {
            return { error: result.error };
          }

          const metadata = await fileStorage.writeFile(name, result.text, { conversationId });
          const fuzzy = result.applied.filter((a) => a.strategy !== 'exact');

          return {
            success: true,
            name: metadata.name,
            size: metadata.size,
            updatedAt: metadata.updatedAt,
            editsApplied: result.applied.length,
            // Surface an inexact match so the model can verify rather than assume.
            ...(fuzzy.length > 0
              ? {
                  note:
                    `${fuzzy.length} edit(s) matched only after normalizing whitespace/indentation. ` +
                    'Read the file back to confirm the result is correct.',
                }
              : {}),
            previewUrl: previewUrlFor(metadata.name, metadata.mimeType),
          };
        },
      }),

      file_patch: tool({
        description:
          'Apply a unified diff to an existing text file. Prefer file_edit unless you already ' +
          'have a diff. Hunk line numbers are IGNORED — each hunk is located by its context ' +
          'and removal lines, so use "@@ ... @@" as the header. Context lines must be prefixed ' +
          'with a space, removals with "-", additions with "+", and every hunk needs at least ' +
          'one context or removal line copied verbatim from the file. A hunk that does not ' +
          'match the file is an error and nothing is written.',
        inputSchema: z.object({
          name: z.string().describe('File name to patch'),
          patch: z.string().describe('Unified diff content'),
        }),
        execute: async ({ name, patch }) => {
          const original = await fileStorage.readFileAsText(name);
          if (original === null) {
            return { error: `File "${name}" not found. Use file_write to create it.` };
          }

          const result = applyUnifiedDiff(original, patch);
          if (!result.ok) {
            return { error: `Failed to apply patch: ${result.error}` };
          }

          const metadata = await fileStorage.writeFile(name, result.text, { conversationId });
          const fuzzy = result.strategies.filter((s) => s !== 'exact');

          return {
            success: true,
            name: metadata.name,
            size: metadata.size,
            updatedAt: metadata.updatedAt,
            hunksApplied: result.hunks,
            ...(fuzzy.length > 0
              ? {
                  note:
                    `${fuzzy.length} hunk(s) matched only after normalizing whitespace/indentation. ` +
                    'Read the file back to confirm the result is correct.',
                }
              : {}),
            previewUrl: previewUrlFor(metadata.name, metadata.mimeType),
          };
        },
      }),

      file_list: tool({
        description:
          'List all files stored in the extension with their metadata (name, size, type, creation time).',
        inputSchema: z.object({}),
        execute: async () => {
          const files = await fileStorage.listFiles();
          if (files.length === 0) {
            return { files: [], message: 'No files stored' };
          }
          return {
            files: files.map((f) => ({
              name: f.name,
              mimeType: f.mimeType,
              size: f.size,
              createdAt: new Date(f.createdAt).toISOString(),
              updatedAt: new Date(f.updatedAt).toISOString(),
              previewable: getPreviewCategory(f.mimeType) !== 'unsupported',
            })),
            total: files.length,
          };
        },
      }),

      file_delete: tool({
        description: 'Delete a file from the extension storage.',
        inputSchema: z.object({
          name: z.string().describe('File name to delete'),
        }),
        execute: async ({ name }) => {
          const exists = await fileStorage.exists(name);
          if (!exists) {
            return { error: `File "${name}" not found` };
          }
          await fileStorage.deleteFile(name);
          return { success: true, deleted: name };
        },
      }),

      file_open_preview: tool({
        description:
          'Open a file in the preview page in a new browser tab. Supports images, text, markdown, HTML, and code files.',
        inputSchema: z.object({
          name: z.string().describe('File name to preview'),
        }),
        execute: async ({ name }) => {
          const exists = await fileStorage.exists(name);
          if (!exists) {
            return { error: `File "${name}" not found` };
          }

          const metadata = await fileStorage.getMetadata(name);
          let category = getPreviewCategory(metadata?.mimeType || '');

          // Fallback: sniff content for legacy files stored as octet-stream
          if (category === 'unsupported') {
            const blob = await fileStorage.readFileAsBlob(name);
            if (blob && await isLikelyTextContent(blob)) {
              category = 'text';
            }
          }

          if (category === 'unsupported') {
            return {
              error: `File "${name}" (${metadata?.mimeType}) is not previewable. Only images and text files are supported.`,
            };
          }

          // Open the preview page with the file name as query parameter
          const previewUrl = chrome.runtime.getURL(`/preview.html?file=${encodeURIComponent(name)}`);
          await chrome.tabs.create({ url: previewUrl, active: true });

          return {
            success: true,
            message: `Opened preview for "${name}"`,
            url: previewUrl,
          };
        },
      }),

      file_download: tool({
        description:
          'Download one or more files from extension storage to the user\'s local disk. When multiple files are specified, they are automatically bundled into a zip archive for a single download. Single files are downloaded directly.',
        inputSchema: z.object({
          names: z
            .array(z.string())
            .min(1)
            .describe('List of file names to download'),
          zipName: z
            .string()
            .optional()
            .describe('Custom zip file name when downloading multiple files (default: "files.zip")'),
        }),
        execute: async ({ names, zipName }) => {
          // Single file: download directly
          if (names.length === 1) {
            const name = names[0]!;
            const blob = await fileStorage.readFileAsBlob(name);
            if (!blob) {
              return { success: false, error: `File "${name}" not found` };
            }

            const url = URL.createObjectURL(blob);
            const filename = name.includes('/') ? name.split('/').pop()! : name;

            try {
              const downloadId = await chrome.downloads.download({
                url,
                filename,
                saveAs: false,
              });
              setTimeout(() => URL.revokeObjectURL(url), 10000);
              return { success: true, message: `Downloaded "${filename}"`, downloadId };
            } catch (err) {
              URL.revokeObjectURL(url);
              return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }

          // Multiple files: bundle into zip
          const result = await downloadAsZip(
            names.map((name) => ({ name })),
            zipName || 'files.zip',
          );

          return {
            success: result.success,
            message: result.success
              ? `Downloaded ${result.totalFiles} file(s) as "${zipName || 'files.zip'}"`
              : 'Failed to create zip archive',
            totalFiles: result.totalFiles,
            failedFiles: result.failedFiles.length > 0 ? result.failedFiles : undefined,
          };
        },
      }),
    };
  }
}
