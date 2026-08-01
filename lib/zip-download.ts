/**
 * Zip download utility.
 *
 * Bundles multiple files (from IndexedDB) into a zip archive and triggers
 * a browser download via chrome.downloads or fallback <a> element.
 */
import { zipSync, strToU8 } from 'fflate';
import { fileStorage } from '@/lib/mcp/file-storage';

export interface ZipFileEntry {
  /** Full file name (used as path inside the zip) */
  name: string;
  /** Optional: override the path inside zip (strip prefix, etc.) */
  zipPath?: string;
}

/**
 * Bundle multiple files from extension storage into a zip and trigger download.
 *
 * @param files - List of file entries to include
 * @param zipName - Name of the output zip file (e.g. "folder.zip")
 * @returns Object with success status and details
 */
export async function downloadAsZip(
  files: ZipFileEntry[],
  zipName: string,
): Promise<{ success: boolean; totalFiles: number; failedFiles: string[] }> {
  const zipData: Record<string, Uint8Array> = {};
  const failedFiles: string[] = [];

  for (const entry of files) {
    const blob = await fileStorage.readFileAsBlob(entry.name);
    if (!blob) {
      failedFiles.push(entry.name);
      continue;
    }

    const arrayBuffer = await blob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    const pathInZip = entry.zipPath ?? entry.name;
    zipData[pathInZip] = uint8;
  }

  if (Object.keys(zipData).length === 0) {
    return { success: false, totalFiles: 0, failedFiles };
  }

  // Create zip synchronously (fflate's zipSync is fast for reasonable file sizes)
  const zipped = zipSync(zipData, { level: 6 });
  const blob = new Blob([zipped], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);

  // Use <a> download for UI pages (options/sidepanel) — blob URL is same-origin
  // so the `download` attribute reliably sets the filename.
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Revoke after delay to allow download to start
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  return {
    success: true,
    totalFiles: Object.keys(zipData).length,
    failedFiles,
  };
}

/**
 * Create a zip Blob from file entries (without triggering download).
 * Useful for MCP tools that need more control over the download process.
 */
export async function createZipBlob(
  files: ZipFileEntry[],
): Promise<{ blob: Blob; includedFiles: string[]; failedFiles: string[] }> {
  const zipData: Record<string, Uint8Array> = {};
  const includedFiles: string[] = [];
  const failedFiles: string[] = [];

  for (const entry of files) {
    const blob = await fileStorage.readFileAsBlob(entry.name);
    if (!blob) {
      failedFiles.push(entry.name);
      continue;
    }

    const arrayBuffer = await blob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    const pathInZip = entry.zipPath ?? entry.name;
    zipData[pathInZip] = uint8;
    includedFiles.push(entry.name);
  }

  const zipped = zipSync(zipData, { level: 6 });
  const blob = new Blob([zipped], { type: 'application/zip' });

  return { blob, includedFiles, failedFiles };
}
