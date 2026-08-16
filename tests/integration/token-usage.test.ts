import { describe, it, expect } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { tool, isStepCount } from 'ai';
import { z } from 'zod';
import { runAgentLoop } from '@/lib/ai';
import type { TokenUsageStats } from '@/types';

/**
 * Integration test for token usage collection against a real endpoint.
 *
 * Uses http://192.168.1.1:8848/v1 as the gateway. The gateway must be running
 * and serving both OpenAI-compatible chat completions and Anthropic-compatible
 * messages endpoints.
 *
 * Run with: npx vitest run tests/integration/token-usage.test.ts
 */

const ENDPOINT = 'http://192.168.1.1:8848/v1';
const API_KEY = 'test'; // placeholder for local gateway

// Try to connect to the endpoint; skip if unreachable.
async function isEndpointReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${ENDPOINT}/models`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    clearTimeout(timeout);
    return res.ok || res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

// We'll determine at runtime if we can run these tests
let reachable = false;
try {
  reachable = await isEndpointReachable();
} catch {
  reachable = false;
}

const describeEndpoint = reachable ? describe : describe.skip;

describeEndpoint('Token usage collection (real endpoint at 192.168.1.1:8848)', () => {
  // ─── OpenAI Chat Completions ─────────────────────────────────────────

  describe('openai-chat provider', () => {
    const openai = createOpenAI({
      apiKey: API_KEY,
      baseURL: ENDPOINT,
    });

    it('collects token usage from a simple text response', async () => {
      const model = openai.chat('claude-sonnet-4-20250514');
      let reportedUsage: TokenUsageStats | undefined;

      const { parts, stoppedReason, usage } = await runAgentLoop({
        model,
        messages: [
          { role: 'user', content: 'Say "hello world" and nothing else.' },
        ],
        onUpdate: () => {},
        onUsage: (u) => { reportedUsage = u; },
      });

      console.log('\n[openai-chat] Simple text response usage:', JSON.stringify(usage, null, 2));
      console.log('[openai-chat] Parts:', parts.map(p => p.type).join(', '));

      expect(stoppedReason).toBe('finished');
      expect(usage.inputTokens).toBeGreaterThan(0);
      expect(usage.outputTokens).toBeGreaterThan(0);
      expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
      expect(usage.steps).toHaveLength(1);
      expect(usage.steps![0]!.step).toBe(0);
      // The onUsage callback should have been called with the same data.
      expect(reportedUsage).toEqual(usage);
    });

    it('collects token usage across multiple tool steps', async () => {
      const model = openai.chat('claude-sonnet-4-20250514');
      const usageSnapshots: TokenUsageStats[] = [];

      const getWeather = tool({
        description: 'Get the current weather for a city',
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }: { city: string }) => ({ temperature: 22, condition: 'sunny', city }),
      });

      const { usage } = await runAgentLoop({
        model,
        tools: { get_weather: getWeather },
        messages: [
          {
            role: 'user',
            content: 'What is the weather in Tokyo? Use the get_weather tool.',
          },
        ],
        onUpdate: () => {},
        onUsage: (u) => { usageSnapshots.push(structuredClone(u)); },
      });

      console.log('\n[openai-chat] Multi-step tool usage:', JSON.stringify(usage, null, 2));
      console.log('[openai-chat] Usage snapshots received:', usageSnapshots.length);

      expect(usage.inputTokens).toBeGreaterThan(0);
      expect(usage.outputTokens).toBeGreaterThan(0);
      expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
      // Should have at least 2 steps: tool call + final answer
      expect(usage.steps!.length).toBeGreaterThanOrEqual(2);

      // Each step should have valid token counts
      for (const step of usage.steps ?? []) {
        expect(step.inputTokens).toBeGreaterThanOrEqual(0);
        expect(step.outputTokens).toBeGreaterThanOrEqual(0);
        expect(step.totalTokens).toBe(step.inputTokens + step.outputTokens);
      }

      // Total should equal sum of steps
      const sumInput = (usage.steps ?? []).reduce((acc, s) => acc + s.inputTokens, 0);
      const sumOutput = (usage.steps ?? []).reduce((acc, s) => acc + s.outputTokens, 0);
      expect(usage.inputTokens).toBe(sumInput);
      expect(usage.outputTokens).toBe(sumOutput);

      // onUsage should have been called after each step
      expect(usageSnapshots.length).toBe((usage.steps ?? []).length);
      // Each snapshot should be progressively larger
      for (let i = 1; i < usageSnapshots.length; i++) {
        expect(usageSnapshots[i]!.totalTokens).toBeGreaterThanOrEqual(
          usageSnapshots[i - 1]!.totalTokens,
        );
      }
    });

    it('reports cache read tokens when present', async () => {
      const model = openai.chat('claude-sonnet-4-20250514');

      // Send two identical requests to increase chance of cache hit
      const longSystem =
        'You are a helpful assistant. '.repeat(100) +
        'Always respond concisely.';

      const runOnce = async () => {
        const { usage } = await runAgentLoop({
          model,
          system: longSystem,
          messages: [
            { role: 'user', content: 'Say "hi".' },
          ],
          onUpdate: () => {},
        });
        return usage;
      };

      const usage1 = await runOnce();
      // Wait a moment for cache to be written
      await new Promise((r) => setTimeout(r, 1000));
      const usage2 = await runOnce();

      console.log('\n[openai-chat] Cache test - Run 1:', JSON.stringify(usage1, null, 2));
      console.log('[openai-chat] Cache test - Run 2:', JSON.stringify(usage2, null, 2));

      // We can't guarantee a cache hit, but we verify the fields are populated correctly
      expect(usage1.inputTokens).toBeGreaterThan(0);
      expect(usage2.inputTokens).toBeGreaterThan(0);

      if (usage2.cacheReadTokens && usage2.cacheReadTokens > 0) {
        console.log('[openai-chat] ✓ Cache read detected:', usage2.cacheReadTokens);
      } else {
        console.log('[openai-chat] ⓘ No cache read tokens (may depend on provider support)');
      }
    });
  });

  // ─── Anthropic Provider ──────────────────────────────────────────────

  describe('anthropic provider', () => {
    const anthropic = createAnthropic({
      apiKey: API_KEY,
      baseURL: ENDPOINT,
    });

    it('collects token usage from a simple text response', async () => {
      const model = anthropic('claude-sonnet-4-20250514');
      let reportedUsage: TokenUsageStats | undefined;

      const { parts, stoppedReason, usage } = await runAgentLoop({
        model,
        messages: [
          { role: 'user', content: 'Say "hello world" and nothing else.' },
        ],
        onUpdate: () => {},
        onUsage: (u) => { reportedUsage = u; },
      });

      console.log('\n[anthropic] Simple text response usage:', JSON.stringify(usage, null, 2));
      console.log('[anthropic] Parts:', parts.map(p => p.type).join(', '));

      expect(stoppedReason).toBe('finished');
      expect(usage.inputTokens).toBeGreaterThan(0);
      expect(usage.outputTokens).toBeGreaterThan(0);
      expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
      expect(usage.steps).toHaveLength(1);
      expect(reportedUsage).toEqual(usage);
    });

    it('collects token usage across multiple tool steps', async () => {
      const model = anthropic('claude-sonnet-4-20250514');
      const usageSnapshots: TokenUsageStats[] = [];

      const calculator = tool({
        description: 'Calculate a math expression',
        inputSchema: z.object({ expression: z.string() }),
        execute: async ({ expression }: { expression: string }) => {
          try {
            // Safe eval for simple math
            const result = Function('"use strict"; return (' + expression + ')')();
            return { result: String(result) };
          } catch {
            return { error: 'Invalid expression' };
          }
        },
      });

      const { usage } = await runAgentLoop({
        model,
        tools: { calculator },
        messages: [
          {
            role: 'user',
            content: 'What is 42 * 17? Use the calculator tool.',
          },
        ],
        onUpdate: () => {},
        onUsage: (u) => { usageSnapshots.push(structuredClone(u)); },
      });

      console.log('\n[anthropic] Multi-step tool usage:', JSON.stringify(usage, null, 2));
      console.log('[anthropic] Usage snapshots received:', usageSnapshots.length);

      expect(usage.inputTokens).toBeGreaterThan(0);
      expect(usage.outputTokens).toBeGreaterThan(0);
      expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
      expect(usage.steps!.length).toBeGreaterThanOrEqual(2);

      // Total should equal sum of steps
      const sumInput = (usage.steps ?? []).reduce((acc, s) => acc + s.inputTokens, 0);
      const sumOutput = (usage.steps ?? []).reduce((acc, s) => acc + s.outputTokens, 0);
      expect(usage.inputTokens).toBe(sumInput);
      expect(usage.outputTokens).toBe(sumOutput);

      // Progressive snapshots
      expect(usageSnapshots.length).toBe((usage.steps ?? []).length);
      for (let i = 1; i < usageSnapshots.length; i++) {
        expect(usageSnapshots[i]!.totalTokens).toBeGreaterThanOrEqual(
          usageSnapshots[i - 1]!.totalTokens,
        );
      }
    });

    it('reports cache read tokens when present', async () => {
      const model = anthropic('claude-sonnet-4-20250514');

      const longSystem =
        'You are a helpful assistant. '.repeat(100) +
        'Always respond concisely.';

      const runOnce = async () => {
        const { usage } = await runAgentLoop({
          model,
          system: longSystem,
          messages: [
            { role: 'user', content: 'Say "hi".' },
          ],
          onUpdate: () => {},
        });
        return usage;
      };

      const usage1 = await runOnce();
      await new Promise((r) => setTimeout(r, 1000));
      const usage2 = await runOnce();

      console.log('\n[anthropic] Cache test - Run 1:', JSON.stringify(usage1, null, 2));
      console.log('[anthropic] Cache test - Run 2:', JSON.stringify(usage2, null, 2));

      expect(usage1.inputTokens).toBeGreaterThan(0);
      expect(usage2.inputTokens).toBeGreaterThan(0);

      if (usage2.cacheReadTokens && usage2.cacheReadTokens > 0) {
        console.log('[anthropic] ✓ Cache read detected:', usage2.cacheReadTokens);
      } else {
        console.log('[anthropic] ⓘ No cache read tokens (may depend on provider support)');
      }
    });
  });
});
