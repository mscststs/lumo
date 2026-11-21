#!/usr/bin/env node
/**
 * Microsoft Edge Add-ons v1.1 发布脚本（API key 鉴权）。
 *
 * v1.1 的接口比 Chrome Web Store 简单：上传草稿包 → 轮询上传结果 → 提交草稿发布
 * → 轮询发布结果。没有「查询已发布版本」的只读接口，所以版本前进的判断交给商店：
 * 包里的版本不比线上高时，发布操作会返回 `NoModulesUpdated`，脚本会把它翻译成
 * 可执行的中文提示，而不是一句 500。
 *
 * 用法：
 *   node scripts/release/edge-publish.mjs --mode check
 *   node scripts/release/edge-publish.mjs --mode upload  --expected-version v1.0.6
 *   node scripts/release/edge-publish.mjs --mode publish --expected-version v1.0.6
 *   node scripts/release/edge-publish.mjs --mode publish --skip-upload   # 仅重新提交
 *
 * 需要环境变量：EDGE_API_KEY / EDGE_CLIENT_ID / EDGE_PRODUCT_ID
 * （`check` 模式除外）。productID 必须是 Partner Center 里的产品 GUID，
 * 不是商店里 32 位的扩展 ID；EDGE_PRODUCT_ID 缺失时回退读 EDGE_CRX_ID。
 */
import { access, appendFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { strFromU8, unzipSync } from 'fflate';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 默认指向真实服务；EDGE_API_BASE 覆盖只用于本地 mock 测试，CI 不设置。
const API = process.env.EDGE_API_BASE || 'https://api.addons.microsoftedge.microsoft.com';
const POLL_INTERVAL_MS = Number(process.env.EDGE_POLL_INTERVAL_MS) || 5_000;
const PRODUCT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 商店扩展 ID / Chrome 扩展 ID 的字母表只有 a-p，用来区分「填错了哪一种 ID」。
const STORE_EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

const { values: options } = parseArgs({
  options: {
    mode: { type: 'string', default: 'publish' },
    zip: { type: 'string' },
    'expected-version': { type: 'string', default: '' },
    notes: { type: 'string', default: '' },
    'timeout-ms': { type: 'string', default: '600000' },
    'skip-upload': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

if (options.help) {
  console.log(
    'Usage: edge-publish.mjs [--mode check|upload|publish] [--expected-version v1.2.3]\n' +
      '                       [--zip .output/<name>-1.2.3-chrome.zip]\n' +
      '                       [--notes "certification notes"]\n' +
      '                       [--timeout-ms 600000] [--skip-upload]',
  );
  process.exit(0);
}

const MODES = new Set(['check', 'upload', 'publish']);
const mode = options.mode;
const expectedVersion = normalizeTagVersion(options['expected-version']) || undefined;
const certificationNotes = options.notes.trim();

let timeoutMs = 0;
let apiKey = '';
let clientId = '';
let productId = '';
let lastOperationId = '';

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n✖ ${message}`);
  await writeSummary([
    '## Microsoft Edge Add-ons publish failed',
    '',
    '```',
    message,
    '```',
  ]);
  process.exitCode = 1;
});

async function main() {
  if (!MODES.has(mode)) {
    fatal(`Unknown --mode "${mode}". Expected one of: ${[...MODES].join(', ')}`);
  }
  if (options['skip-upload'] && mode !== 'publish') {
    fatal('--skip-upload is only valid with --mode publish.');
  }
  timeoutMs = Number(options['timeout-ms']);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    fatal(`Invalid --timeout-ms "${options['timeout-ms']}"`);
  }

  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const localVersion = packageJson.version;
  assertVersion(localVersion, 'package.json version');

  if (expectedVersion && !versionEquals(expectedVersion, localVersion)) {
    fatal(
      `Tag/package version mismatch: expected ${expectedVersion}, ` +
        `but package.json is ${localVersion}. Bump package.json before tagging.`,
    );
  }

  const zipPath = await resolveZip(localVersion);
  const manifestVersion = await readZipManifestVersion(zipPath);
  assertVersion(manifestVersion, 'zip manifest version');

  if (!versionEquals(manifestVersion, localVersion)) {
    fatal(
      `Zip manifest version ${manifestVersion} does not match package.json ${localVersion}. ` +
        'The zip is stale — run "npm run zip" again.',
    );
  }

  const targetVersion = expectedVersion ?? localVersion;
  log(`Local package OK: ${path.relative(ROOT, zipPath)} (version ${targetVersion})`);

  if (mode === 'check') {
    await writeSummary([
      '## Microsoft Edge Add-ons package check',
      '',
      `- Version: \`${targetVersion}\``,
      `- Package: \`${path.relative(ROOT, zipPath)}\``,
      '- No API calls were made.',
    ]);
    return;
  }

  // secret 里带换行/空格会让 Authorization 头直接非法，粘贴时最容易混进来。
  apiKey = requireEnv('EDGE_API_KEY').trim();
  clientId = requireEnv('EDGE_CLIENT_ID').trim();
  productId = resolveProductId();

  const skipUpload = Boolean(options['skip-upload']);

  if (skipUpload) {
    log('Skipping upload; publishing the draft the store already holds.');
  } else {
    log(`Uploading ${path.relative(ROOT, zipPath)}…`);
    lastOperationId = await uploadPackage(zipPath);
    await waitForUpload(lastOperationId);
  }

  if (mode === 'upload') {
    printStatus({ productId, targetVersion, uploadOperation: lastOperationId });
    await writeSummary(summaryLines({ zipPath, targetVersion, mode, uploadOperation: lastOperationId }));
    return;
  }

  lastOperationId = await submitForPublish(targetVersion);
  const result = await waitForPublish(lastOperationId);

  printStatus({ productId, targetVersion, publishOperation: lastOperationId, result });
  await writeSummary(summaryLines({ zipPath, targetVersion, mode, publishOperation: lastOperationId }));
}

/** Partner Center 的产品 ID 是 GUID；填成商店扩展 ID 是最常见的 404 原因。 */
function resolveProductId() {
  const raw = (process.env.EDGE_PRODUCT_ID || process.env.EDGE_CRX_ID || '').trim();
  if (!raw) {
    fatal(
      'Missing required environment variable EDGE_PRODUCT_ID. ' +
        'Use the product ID (GUID) from Partner Center → Microsoft Edge → Overview.',
    );
  }
  if (STORE_EXTENSION_ID_PATTERN.test(raw)) {
    fatal(
      `EDGE_PRODUCT_ID "${raw}" is a store extension ID, but the Add-ons API needs the ` +
        'product ID GUID from Partner Center → Microsoft Edge → Overview (for example ' +
        'd34f98f5-f9b7-42b1-bebb-98707202b21d). Add it as the EDGE_PRODUCT_ID secret.',
    );
  }
  if (!PRODUCT_ID_PATTERN.test(raw)) {
    fatal(`EDGE_PRODUCT_ID "${raw}" is not a GUID. Copy the product ID from Partner Center.`);
  }
  if (!PRODUCT_ID_PATTERN.test(clientId)) {
    console.warn(
      '⚠ EDGE_CLIENT_ID is not a GUID; check the Client ID shown on the Partner Center ' +
        '"Publish API" page.',
    );
  }
  return raw;
}

async function uploadPackage(zipPath) {
  const buffer = await readFile(zipPath);
  const response = await fetch(`${API}/v1/products/${productId}/submissions/draft/package`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/zip',
    },
    body: buffer,
  });

  if (response.status !== 202) {
    fatal(
      `Upload failed (${response.status} ${response.statusText}): ${await response.text()}` +
        httpFailureHint(response.status),
    );
  }

  const operationId = operationIdFrom(response);
  log(`Upload accepted (operation ${operationId}).`);
  return operationId;
}

async function waitForUpload(operationId) {
  return waitForOperation({
    label: 'package upload',
    url: `/v1/products/${productId}/submissions/draft/package/operations/${operationId}`,
  });
}

async function submitForPublish(targetVersion) {
  const notes =
    certificationNotes ||
    `Release ${targetVersion} — automated submission from the tagged CI build.`;

  const response = await fetch(`${API}/v1/products/${productId}/submissions`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ notes }),
  });

  if (response.status !== 202) {
    fatal(
      `Publish request failed (${response.status} ${response.statusText}): ${await response.text()}` +
        httpFailureHint(response.status),
    );
  }

  const operationId = operationIdFrom(response);
  log(`Publish accepted (operation ${operationId}).`);
  return operationId;
}

async function waitForPublish(operationId) {
  return waitForOperation({
    label: 'publish',
    url: `/v1/products/${productId}/submissions/operations/${operationId}`,
  });
}

/**
 * 两个轮询接口的响应形状一致：200 + `{ status: 'InProgress' | 'Succeeded' | 'Failed' }`。
 * 轮询期间的瞬时失败（网络抖动、429、5xx）不应该中断整次发布，因此这里只把
 * 明确的 `Failed` 当成失败，其余情况一直等到 deadline。
 */
async function waitForOperation({ label, url }) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '(unknown)';

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let result;
    try {
      result = await getJson(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`⚠ ${label} status poll failed, retrying: ${message}`);
      continue;
    }

    // 鉴权失败或产品 ID 不存在时重试没有意义，直接失败并保留原始响应。
    if ([401, 403, 404].includes(result.httpStatus)) {
      fatal(`GET ${url} failed (${result.httpStatus}): ${result.text}${httpFailureHint(result.httpStatus)}`);
    }

    const body = result.body;
    lastStatus = body?.status ?? `(http ${result.httpStatus})`;
    log(`${label} status: ${lastStatus}`);

    if (body?.status === 'Succeeded') return body;

    if (body?.status === 'Failed') {
      const details = formatOperationFailure(body);
      fatal(`The store rejected the ${label}: ${details}`);
    }
  }

  fatal(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the ${label} ` +
      `(last status: ${lastStatus}).`,
  );
}

/** 4xx 往往只是「secret 填错了」，把排查方向直接写在错误后面。 */
function httpFailureHint(status) {
  if (status === 401 || status === 403) {
    return (
      '\n  → EDGE_API_KEY / EDGE_CLIENT_ID 无效或已过期：在 Partner Center → Microsoft Edge' +
      ' → Publish API 里重新生成，并确认两者属于同一个账号。'
    );
  }
  if (status === 404) {
    return (
      '\n  → EDGE_PRODUCT_ID 不是这个账号下的产品 GUID（注意不是商店里 32 位的扩展 ID）：' +
      'Partner Center → Microsoft Edge → Overview 里复制 Product ID。'
    );
  }
  if (status === 429) {
    return '\n  → 触发限流，等几分钟后重试。';
  }
  return '';
}

/** 把商店的错误码翻译成「下一步该做什么」，否则日志里只有一串英文。 */
function formatOperationFailure(body) {
  const hints = {
    NoModulesUpdated:
      '包里的版本没有高于线上版本，或提交内容与已发布版本完全一致。' +
      ' 先提升 package.json 的 version 再重新打包。',
    InProgressSubmission:
      '这个产品还有一次提交在审核中。等审核结束后重跑，或用 --skip-upload 只重新提交。',
    UnpublishInProgress: '产品正在下架流程中，等它结束后再发布。',
    CreateNotAllowed: '产品还不存在：首次发布必须先在 Partner Center 手动创建。',
    ModuleStateUnPublishable: '商店认为包里有模块非法，按下面的模块错误修正后重新打包。',
    SubmissionValidationError: '提交表单校验失败（截图、描述、权限说明等），去 Partner Center 补齐。',
  };

  const parts = [body.message, body.errorCode && `errorCode=${body.errorCode}`]
    .filter(Boolean)
    .join(' ');

  const errors = Array.isArray(body.errors)
    ? body.errors.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    : [];
  const detail = errors.length ? ` — ${errors.join('; ')}` : '';
  const hint = body.errorCode ? hints[body.errorCode] : undefined;

  return `${parts || 'no message'}${detail}${hint ? `\n  → ${hint}` : ''}`;
}

/**
 * 轮询接口在「还在处理」时也可能返回非 2xx，所以这里不抛异常，
 * 由调用方按 httpStatus + status 决定是继续等还是立刻失败。
 */
async function getJson(url) {
  const response = await fetch(`${API}${url}`, { headers: authHeaders() });
  const text = await response.text();

  let body = {};
  if (text && response.status !== 204) {
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON 的错误页也只是「还没好」，把原文留给调用方展示。
      body = {};
    }
  }

  return { httpStatus: response.status, text, body };
}

function authHeaders() {
  return {
    Authorization: `ApiKey ${apiKey}`,
    'X-ClientID': clientId,
    Accept: 'application/json',
  };
}

/** 202 的 Location 头里是 operationID：可能是绝对 URL，也可能只是相对路径。 */
function operationIdFrom(response) {
  const location = response.headers.get('location');
  if (!location) {
    fatal('The store accepted the request but returned no Location header (operation ID).');
  }
  const operationId = new URL(location, `${API}/`).pathname.split('/').filter(Boolean).at(-1);
  if (!operationId) fatal(`Could not read an operation ID from Location "${location}".`);
  return operationId;
}

function summaryLines({ zipPath, targetVersion, mode: runMode, uploadOperation, publishOperation }) {
  const lines = [
    '## Microsoft Edge Add-ons publish',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Mode | \`${runMode}\` |`,
    `| Target version | \`${targetVersion}\` |`,
    `| Package | \`${path.relative(ROOT, zipPath)}\` |`,
    `| Product ID | \`${productId}\` |`,
  ];
  if (uploadOperation) lines.push(`| Upload operation | \`${uploadOperation}\` |`);
  if (publishOperation) lines.push(`| Publish operation | \`${publishOperation}\` |`);
  return lines;
}

async function resolveZip(version) {
  if (options.zip) {
    const explicit = path.resolve(ROOT, options.zip);
    try {
      await access(explicit);
    } catch {
      fatal(`--zip file not found: ${explicit}`);
    }
    if (!explicit.endsWith('.zip')) fatal(`--zip must point to a .zip file: ${explicit}`);
    return explicit;
  }

  const outputDir = path.join(ROOT, '.output');
  let entries;
  try {
    entries = await readdir(outputDir);
  } catch {
    fatal(`No build output at ${outputDir}. Run "npm run zip" first.`);
  }

  const candidates = entries.filter((name) => name.endsWith('-chrome.zip'));
  const matching = candidates.filter((name) => name.endsWith(`-${version}-chrome.zip`));

  if (matching.length === 1) return path.join(outputDir, matching[0]);

  if (matching.length > 1) {
    fatal(
      `Found multiple packages for version ${version}: ${matching.join(', ')}. ` +
        'Remove stale zips or pass --zip.',
    );
  }

  fatal(
    `No Chrome package for version ${version} in ${outputDir}. ` +
      `Found: ${candidates.length ? candidates.join(', ') : '(none)'}. Run "npm run zip" first.`,
  );
}

async function readZipManifestVersion(zipPath) {
  const archive = unzipSync(await readFile(zipPath), {
    filter: (file) => file.name === 'manifest.json',
  });
  const manifest = archive['manifest.json'];
  if (!manifest) fatal(`${zipPath} has no top-level manifest.json.`);
  return JSON.parse(strFromU8(manifest)).version;
}

function printStatus(status) {
  console.log(JSON.stringify(status, null, 2));
}

async function writeSummary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    await appendFile(file, `${lines.join('\n')}\n\n`);
  } catch {
    // Summary 只是锦上添花，写失败不应该影响发布结果。
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fatal(`Missing required environment variable ${name}.`);
  return value;
}

function normalizeTagVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '');
}

function assertVersion(version, source) {
  if (!/^\d+(\.\d+){0,3}$/.test(String(version))) {
    fatal(`Invalid extension version "${version}" from ${source}.`);
  }
}

function versionEquals(a, b) {
  return compareVersions(a, b) === 0;
}

/** 按 Chromium 扩展的 1~4 段数字版本比较；缺省段按 0 处理。 */
function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  return 0;
}

function log(message) {
  console.log(`• ${message}`);
}

function fatal(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
