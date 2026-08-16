/**
 * File Storage Layer - IndexedDB based file storage for FileMCP.
 *
 * Stores files as Blobs in IndexedDB with metadata for management.
 * Supports text and binary files with conversation source tracking.
 *
 * Writes and deletes announce themselves on the event bus, because IndexedDB has
 * no change event of its own and every view of these files (the preview tab, the
 * options file manager, the side panel's conversation file list) would otherwise
 * have to poll to stay correct.
 */
import { emitEvent } from '@/lib/event-bus';

export interface FileMetadata {
  /** File name (unique identifier) */
  name: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Creation timestamp */
  createdAt: number;
  /** Last modified timestamp */
  updatedAt: number;
  /** Source conversation ID (if created during a chat) */
  conversationId?: string;
}

export interface StoredFile {
  /** File name (primary key) */
  name: string;
  /** File content as Blob */
  content: Blob;
  /** File metadata */
  metadata: FileMetadata;
}

const DB_NAME = 'lumo-files';
const DB_VERSION = 1;
const STORE_NAME = 'files';

/**
 * Open (or create) the IndexedDB database for file storage.
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'name' });
        store.createIndex('createdAt', 'metadata.createdAt', { unique: false });
        store.createIndex('conversationId', 'metadata.conversationId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Infer MIME type from file name extension.
 */
export function inferMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    // Text
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    csv: 'text/csv',
    xml: 'text/xml',
    // Code
    js: 'text/javascript',
    ts: 'text/typescript',
    jsx: 'text/javascript',
    tsx: 'text/typescript',
    json: 'application/json',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    toml: 'text/toml',
    py: 'text/x-python',
    rb: 'text/x-ruby',
    go: 'text/x-go',
    rs: 'text/x-rust',
    java: 'text/x-java',
    c: 'text/x-c',
    cpp: 'text/x-c++',
    h: 'text/x-c',
    hpp: 'text/x-c++',
    sh: 'text/x-shellscript',
    bash: 'text/x-shellscript',
    zsh: 'text/x-shellscript',
    bat: 'text/x-bat',
    cmd: 'text/x-bat',
    ps1: 'text/x-powershell',
    psm1: 'text/x-powershell',
    sql: 'text/x-sql',
    graphql: 'text/x-graphql',
    vue: 'text/x-vue',
    svelte: 'text/x-svelte',
    // Config / Data
    ini: 'text/plain',
    cfg: 'text/plain',
    conf: 'text/plain',
    env: 'text/plain',
    log: 'text/plain',
    dockerfile: 'text/plain',
    makefile: 'text/plain',
    gitignore: 'text/plain',
    editorconfig: 'text/plain',
    properties: 'text/plain',
    lock: 'text/plain',
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    // Others
    pdf: 'application/pdf',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
  };
  // Direct extension match
  if (mimeMap[ext]) return mimeMap[ext];

  // Handle dot-prefixed config files (e.g. ".gitignore", ".editorconfig")
  const basename = filename.split('/').pop()?.split('\\').pop()?.toLowerCase() || '';
  const basenameNoExt = basename.startsWith('.') ? basename.slice(1) : '';
  if (basenameNoExt && mimeMap[basenameNoExt]) return mimeMap[basenameNoExt];

  // Handle well-known extensionless files
  const knownTextFiles = ['makefile', 'dockerfile', 'rakefile', 'gemfile', 'procfile', 'license', 'readme', 'changelog'];
  if (knownTextFiles.includes(basename)) return 'text/plain';

  return 'application/octet-stream';
}

/**
 * Detect whether a Blob (or its leading bytes) looks like a plain-text file.
 *
 * Reads the first 8 KB and checks for non-text bytes. The heuristic mirrors
 * what `git` and the UNIX `file` command use:
 * - NULL bytes (0x00) → binary
 * - Control chars except TAB (0x09), LF (0x0A), CR (0x0D) → binary
 * - Bytes ≥ 0x80 are allowed (UTF-8 multibyte)
 *
 * Returns `true` if the sample looks like text, `false` otherwise.
 */
export async function isLikelyTextContent(blob: Blob): Promise<boolean> {
  const SAMPLE_SIZE = 8192; // 8 KB
  const slice = blob.slice(0, SAMPLE_SIZE);
  const buffer = await slice.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    // Allow TAB, LF, CR, and printable ASCII + high bytes (UTF-8)
    if (b === 0x00) return false;
    if (b < 0x08) return false;
    if (b > 0x0d && b < 0x20) return false;
  }
  return true;
}

/**
 * Determine the preview category for a file.
 */
export type PreviewCategory = 'image' | 'text' | 'unsupported';

export function getPreviewCategory(mimeType: string): PreviewCategory {
  if (mimeType.startsWith('image/')) return 'image';
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  ) {
    return 'text';
  }
  return 'unsupported';
}

/**
 * Get the code language identifier from MIME type (for syntax highlighting).
 */
export function getLanguageFromMime(mimeType: string): string | undefined {
  const langMap: Record<string, string> = {
    'text/javascript': 'javascript',
    'text/typescript': 'typescript',
    'text/css': 'css',
    'text/html': 'html',
    'text/markdown': 'markdown',
    'text/xml': 'xml',
    'text/yaml': 'yaml',
    'text/toml': 'toml',
    'text/x-python': 'python',
    'text/x-ruby': 'ruby',
    'text/x-go': 'go',
    'text/x-rust': 'rust',
    'text/x-java': 'java',
    'text/x-c': 'c',
    'text/x-c++': 'cpp',
    'text/x-shellscript': 'bash',
    'text/x-sql': 'sql',
    'text/x-graphql': 'graphql',
    'text/x-vue': 'vue',
    'text/x-svelte': 'svelte',
    'text/csv': 'csv',
    'application/json': 'json',
    'application/xml': 'xml',
  };
  return langMap[mimeType];
}

/**
 * File storage singleton for managing files in IndexedDB.
 */
class FileStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB();
    }
    return this.dbPromise;
  }

  /**
   * Write a file (create or overwrite).
   */
  async writeFile(
    name: string,
    content: string | Blob,
    options?: { conversationId?: string; mimeType?: string },
  ): Promise<FileMetadata> {
    const db = await this.getDB();
    let mimeType = options?.mimeType || inferMimeType(name);
    const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;

    // Content sniffing: when extension-based detection falls back to
    // octet-stream, probe the actual bytes to see if it's plain text.
    if (mimeType === 'application/octet-stream') {
      // String content is always text; for Blobs, sample leading bytes.
      if (typeof content === 'string' || await isLikelyTextContent(blob)) {
        mimeType = 'text/plain';
      }
    }
    const now = Date.now();

    // Check if file already exists to preserve createdAt
    const existing = await this.getMetadata(name);
    const createdAt = existing?.createdAt || now;

    const metadata: FileMetadata = {
      name,
      mimeType,
      size: blob.size,
      createdAt,
      updatedAt: now,
      conversationId: options?.conversationId || existing?.conversationId,
    };

    const storedFile: StoredFile = { name, content: blob, metadata };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(storedFile);
      request.onsuccess = () => {
        // Announced here rather than in the MCP tools because this is the only
        // path every writer shares: `file_write`, `file_edit` and `file_patch`
        // all land here, and so would any future caller that would otherwise
        // have to remember to announce itself.
        emitEvent('files:changed', { names: [name], reason: 'write' });
        resolve(metadata);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Read a file's content as text.
   */
  async readFileAsText(name: string): Promise<string | null> {
    const file = await this.getFile(name);
    if (!file) return null;
    return file.content.text();
  }

  /**
   * Read a file's content as Blob.
   */
  async readFileAsBlob(name: string): Promise<Blob | null> {
    const file = await this.getFile(name);
    if (!file) return null;
    return file.content;
  }

  /**
   * Get a file with its content.
   */
  async getFile(name: string): Promise<StoredFile | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(name);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get only file metadata (without content).
   */
  async getMetadata(name: string): Promise<FileMetadata | null> {
    const file = await this.getFile(name);
    return file?.metadata || null;
  }

  /**
   * List all file metadata.
   */
  async listFiles(): Promise<FileMetadata[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        const files = (request.result as StoredFile[]) || [];
        resolve(
          files
            .map((f) => f.metadata)
            .sort((a, b) => b.createdAt - a.createdAt),
        );
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete a file by name.
   */
  async deleteFile(name: string): Promise<boolean> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(name);
      request.onsuccess = () => {
        emitEvent('files:changed', { names: [name], reason: 'delete' });
        resolve(true);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete every stored file.
   *
   * The names are collected *before* the store is cleared because the change
   * event's contract is to list what was affected — subscribers showing a single
   * file (the preview tab) filter on that list, and an empty one would leave
   * them displaying a file that no longer exists.
   *
   * @returns How many files were deleted.
   */
  async clearFiles(): Promise<number> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const keysRequest = store.getAllKeys();
      keysRequest.onsuccess = () => {
        const names = (keysRequest.result as IDBValidKey[]).map(String);
        const clearRequest = store.clear();
        clearRequest.onsuccess = () => {
          if (names.length > 0) {
            emitEvent('files:changed', { names, reason: 'delete' });
          }
          resolve(names.length);
        };
        clearRequest.onerror = () => reject(clearRequest.error);
      };
      keysRequest.onerror = () => reject(keysRequest.error);
    });
  }

  /**
   * Check if a file exists.
   */
  async exists(name: string): Promise<boolean> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.count(name);
      request.onsuccess = () => resolve(request.result > 0);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get files by conversation ID.
   */
  async getFilesByConversation(conversationId: string): Promise<FileMetadata[]> {
    const all = await this.listFiles();
    return all.filter((f) => f.conversationId === conversationId);
  }

  /**
   * Get the object URL for a file (for preview/download).
   * Caller must revoke the URL when done.
   */
  async getObjectUrl(name: string): Promise<string | null> {
    const blob = await this.readFileAsBlob(name);
    if (!blob) return null;
    return URL.createObjectURL(blob);
  }
}

/** Singleton instance */
export const fileStorage = new FileStorage();
