import { tool } from 'ai';
import { z } from 'zod';
import type {
  IMcpServer,
  McpServerInfo,
  McpServerStatus,
  McpToolDefinition,
  AnyTool,
} from './types';
import { fileStorage, inferMimeType, getPreviewCategory } from './file-storage';
import { downloadAsZip } from '@/lib/zip-download';

/**
 * Apply a unified diff/patch to text content.
 * Supports a simplified patch format:
 *  - Lines starting with `---` and `+++` are header (ignored)
 *  - Lines starting with `@@` denote hunk headers
 *  - Lines starting with `-` are removals
 *  - Lines starting with `+` are additions
 *  - Lines starting with ` ` (space) are context
 */
function applyPatch(original: string, patch: string): string {
  const patchLines = patch.split('\n');
  const originalLines = original.split('\n');
  const result: string[] = [...originalLines];

  let offset = 0; // Track line offset due to additions/removals

  for (let i = 0; i < patchLines.length; i++) {
    const line = patchLines[i];
    if (!line) continue;

    // Parse hunk header: @@ -start,count +start,count @@
    const hunkMatch = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/);
    if (!hunkMatch) continue;

    const origStart = parseInt(hunkMatch[1]!, 10) - 1; // 0-indexed
    let pos = origStart + offset;

    // Process hunk lines
    i++;
    while (i < patchLines.length) {
      const pl = patchLines[i];
      if (pl === undefined || pl.match(/^@@/)) {
        i--; // Let outer loop re-process this line
        break;
      }

      if (pl.startsWith('-')) {
        // Remove line
        result.splice(pos, 1);
        offset--;
      } else if (pl.startsWith('+')) {
        // Add line
        result.splice(pos, 0, pl.slice(1));
        pos++;
        offset++;
      } else {
        // Context line (starts with ' ' or is empty)
        pos++;
      }
      i++;
    }
  }

  return result.join('\n');
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
      description: 'Read, write, patch, and preview files stored in the extension',
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

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'file_read',
        description: 'Read a file content as text',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name to read' },
          },
          required: ['name'],
        },
      },
      {
        name: 'file_write',
        description: 'Write/create a file with the given content',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['name', 'content'],
        },
      },
      {
        name: 'file_patch',
        description: 'Apply a unified diff patch to an existing file',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name to patch' },
            patch: { type: 'string', description: 'Unified diff patch content' },
          },
          required: ['name', 'patch'],
        },
      },
      {
        name: 'file_list',
        description: 'List all stored files with metadata',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'file_delete',
        description: 'Delete a file',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name to delete' },
          },
          required: ['name'],
        },
      },
      {
        name: 'file_open_preview',
        description: 'Open a file in the preview page in a new browser tab',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name to preview' },
          },
          required: ['name'],
        },
      },
      {
        name: 'file_download',
        description: 'Download one or more files from extension storage to the user\'s local disk via browser download. Multiple files are automatically bundled into a zip archive.',
        inputSchema: {
          type: 'object',
          properties: {
            names: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of file names to download',
            },
            zipName: {
              type: 'string',
              description: 'Custom zip file name when downloading multiple files (default: "files.zip")',
            },
          },
          required: ['names'],
        },
      },
    ];
  }

  getAITools(): Record<string, AnyTool> {
    return {
      file_read: tool({
        description:
          'Read a file stored in the extension. Returns the file content as text. Only works for text-based files.',
        inputSchema: z.object({
          name: z.string().describe('File name to read'),
        }),
        execute: async ({ name }) => {
          const content = await fileStorage.readFileAsText(name);
          if (content === null) {
            return { error: `File "${name}" not found` };
          }
          const metadata = await fileStorage.getMetadata(name);
          return {
            name,
            mimeType: metadata?.mimeType,
            size: metadata?.size,
            content,
          };
        },
      }),

      file_write: tool({
        description:
          'Write or create a file in the extension storage. If the file already exists, it will be overwritten. Returns the file metadata and a preview URL on success.',
        inputSchema: z.object({
          name: z.string().describe('File name (e.g. "notes.md", "data.json", "script.py")'),
          content: z.string().describe('File content to write'),
        }),
        execute: async ({ name, content: fileContent }) => {
          // Try to extract conversation ID from the execution context
          let conversationId: string | undefined;
          try {
            const result = await chrome.storage.local.get('currentConversationId');
            conversationId = (result.currentConversationId as string) || undefined;
          } catch {
            // Not available in this context
          }

          const metadata = await fileStorage.writeFile(name, fileContent, { conversationId });

          // Generate preview URL for previewable files
          const category = getPreviewCategory(metadata.mimeType);
          const previewUrl =
            category !== 'unsupported'
              ? chrome.runtime.getURL(`/preview.html?file=${encodeURIComponent(name)}`)
              : undefined;

          return {
            success: true,
            name: metadata.name,
            mimeType: metadata.mimeType,
            size: metadata.size,
            createdAt: metadata.createdAt,
            updatedAt: metadata.updatedAt,
            previewUrl,
          };
        },
      }),

      file_patch: tool({
        description:
          'Apply a unified diff patch to an existing file. The patch should follow the standard unified diff format with @@ hunk headers, - for removals, and + for additions.',
        inputSchema: z.object({
          name: z.string().describe('File name to patch'),
          patch: z.string().describe('Unified diff patch content'),
        }),
        execute: async ({ name, patch }) => {
          const original = await fileStorage.readFileAsText(name);
          if (original === null) {
            return { error: `File "${name}" not found` };
          }

          try {
            const patched = applyPatch(original, patch);
            const metadata = await fileStorage.writeFile(name, patched);

            const category = getPreviewCategory(metadata.mimeType);
            const previewUrl =
              category !== 'unsupported'
                ? chrome.runtime.getURL(`/preview.html?file=${encodeURIComponent(name)}`)
                : undefined;

            return {
              success: true,
              name: metadata.name,
              size: metadata.size,
              updatedAt: metadata.updatedAt,
              previewUrl,
            };
          } catch (err) {
            return {
              error: `Failed to apply patch: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
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
          const category = getPreviewCategory(metadata?.mimeType || '');
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
