import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { tool, isToolUIPart, getToolName } from 'ai';
import { z } from 'zod';
import { createProvider, runAgentLoop } from '@/lib/ai';
import { solidColorPng } from '../helpers/png';
import type { ModelConfig, ProviderConfig } from '@/types';

/**
 * Integration test for the image pipeline against a REAL model.
 *
 * The provider/model is loaded from the user's exported Lumo config
 * (`lumo-config-*.json` under ~/下载, or the path in `LUMO_CONFIG_PATH`).
 * It verifies the full loop: a tool returns an image, the loop strips it from
 * the model prompt and re-injects it as a synthetic user message, and the
 * vision model actually sees and describes the image.
 */

interface LumoConfig {
  providers: ProviderConfig[];
  selectedModel?: { providerId: string; modelId: string };
}

function loadConfig(): LumoConfig | null {
  const candidates = [
    process.env.LUMO_CONFIG_PATH,
    // Auto-discover the newest exported config in the user's Downloads folder.
    ...[...globDownloads()],
  ].filter(Boolean) as string[];

  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const config = JSON.parse(raw) as LumoConfig;
      if (Array.isArray(config.providers) && config.providers.length > 0) return config;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function globDownloads(): string[] {
  const dir = process.env.HOME ? path.join(process.env.HOME, '下载') : '';
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^lumo-config-.+\.json$/.test(name))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

const config = loadConfig();
const selected = config?.selectedModel;
const provider =
  config?.providers.find((p) => p.id === (process.env.LUMO_PROVIDER_ID || selected?.providerId)) ?? undefined;
const model =
  provider?.models.find((m) => m.id === (process.env.LUMO_MODEL_ID || selected?.modelId)) ?? undefined;

const skipReason = !config
  ? 'No lumo config found (set LUMO_CONFIG_PATH or export the config to ~/下载)'
  : !provider
    ? `Provider ${selected?.providerId ?? '?'} not found in config`
    : !model
      ? `Model ${selected?.modelId ?? '?'} not found in provider ${provider.name}`
      : null;

const describeModel = skipReason ? describe.skip : describe;
const run = (label: string, fn: () => Promise<void>) => it(label, fn, 120_000);

describeModel('model vision through the image pipeline (real model from lumo config)', () => {
  if (skipReason) {
    it(`skipped: ${skipReason}`, () => {});
    return;
  }

  run('the model sees a tool-produced image injected as a user message', async () => {
    const dataUrl = solidColorPng(320, 320, [255, 0, 0], [0, 0, 255]);
    const comma = dataUrl.indexOf(',');
    const base64 = dataUrl.slice(comma + 1);

    const captureScreen = tool({
      description: 'Capture the current screen as a PNG image and return it.',
      inputSchema: z.object({}),
      execute: async () => ({
        content: [
          { type: 'image', data: base64, mimeType: 'image/png' },
          { type: 'text', text: 'Screen captured (320x320, png)' },
        ],
        isError: false,
      }),
    });

    const { model: aiModel, providerOptions } = createProvider(provider!, model!);
    const parts: Array<{ type: string; text?: string }> = [];
    let streamError: string | null = null;

    const { parts: finalParts } = await runAgentLoop({
      model: aiModel,
      providerOptions,
      tools: { capture_screen: captureScreen },
      system: 'You are a test assistant. Follow the user instruction exactly and answer in English.',
      messages: [
        {
          role: 'user',
          content: 'Call the capture_screen tool once, then describe the image content you received in detail.',
        },
      ],
      onUpdate: (updated) => {
        parts.length = 0;
        parts.push(...(updated as Array<{ type: string; text?: string }>));
      },
      onError: (error) => {
        streamError = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.error(`[model stream error] ${streamError}`);
      },
    });

    // A stream-level failure (e.g. the gateway rejecting the model) must fail
    // loudly instead of being reported as an empty part list.
    if (streamError) {
      throw new Error(`Model request failed: ${streamError}`);
    }

    const text = finalParts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('\n');

    // eslint-disable-next-line no-console
    console.log(
      `\n[parts] ${finalParts
        .map((p) => {
          if (isToolUIPart(p)) return `tool:${getToolName(p)}(${p.state})`;
          return p.type;
        })
        .join(' | ')}\n`,
    );

    // The loop must have executed the tool at least once.
    expect(finalParts.some((p) => isToolUIPart(p))).toBe(true);
    expect(text.length).toBeGreaterThan(0);

    // A vision model that actually received the image should name both colours.
    const lower = text.toLowerCase();
    expect(lower).toMatch(/red/);
    expect(lower).toMatch(/blue/);

    // eslint-disable-next-line no-console
    console.log(`\n[model: ${provider!.name}/${model!.modelId}] response:\n${text}\n`);
  });
});
