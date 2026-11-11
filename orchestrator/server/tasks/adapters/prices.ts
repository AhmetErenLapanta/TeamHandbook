import { num } from "./frames.js";

/** Dollars per million tokens: plain input, a write to the 5-minute and the 1-hour prompt cache, a cache read, and output. */
interface Rates {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
}

interface Price {
  rates: Rates;
  /** What fast mode charges instead; a model without it has no fast price to estimate from. */
  fast?: Rates;
  /** A request whose prompt is longer than `tokens` pays `rates` here instead. */
  long?: { tokens: number; rates: Rates };
}

const rates = (input: number, read: number, output: number): Rates => ({ input, write5m: input * 1.25, write1h: input * 2, read, output });
const at = (input: number, output: number, read = input / 10): Price => ({ rates: rates(input, read, output) });
const fast = (price: Price, input: number, output: number): Price => ({ ...price, fast: rates(input, (price.rates.read / price.rates.input) * input, output) });

/**
 * The Claude API's list prices, as published on 2026-11-10 (platform.claude.com, Pricing), by the
 * model id a reply names. A model missing here has no estimate: a wrong price would stop a task
 * early or let it run past its cap.
 */
const CLAUDE_PRICES: Record<string, Price> = {
  "claude-fable-5-2": fast(at(8, 40, 0.2), 16, 80),
  "claude-mythos-5-2": fast(at(8, 40, 0.2), 16, 80),
  "claude-fable-5-1": at(10, 50, 0.25),
  "claude-mythos-5-1": at(10, 50, 0.25),
  "claude-fable-5": at(10, 50, 1),
  "claude-mythos-5": at(10, 50, 1),
  "claude-opus-5-5": fast(at(4, 20, 0.2), 8, 40),
  "claude-opus-5": fast(at(5, 25), 10, 50),
  "claude-opus-4-8": fast(at(5, 25), 10, 50),
  "claude-opus-4-7": at(5, 25),
  "claude-opus-4-6": at(5, 25),
  "claude-opus-4-5": at(5, 25),
  "claude-sonnet-5-5": at(2, 10, 0.1),
  "claude-sonnet-5": at(2, 10),
  "claude-sonnet-4-6": at(3, 15),
  "claude-sonnet-4-5": at(3, 15),
  "claude-haiku-5-5": { ...at(0.1, 0.5), long: { tokens: 100_000, rates: rates(0.5, 0.05, 2.5) } },
  "claude-haiku-4-5": at(1, 5),
};

/** A model as Claude Code names it, without a dated snapshot's suffix or a context-window tag such as `[1m]`. */
const modelId = (model: string) => model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");

/**
 * What one reply of a Claude model cost by its `usage`, in dollars, or null when its model has no
 * price here or its usage holds no count. A cache write that does not say which cache it went to
 * is priced as the 1-hour one, the dearer, so the estimate a cap is held to is never short.
 */
export function claudeReplyCost(model: string, usage: Record<string, unknown>): number | null {
  const price = CLAUDE_PRICES[modelId(model)];
  if (!price) return null;
  const counts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens, usage.output_tokens].map(num);
  if (counts.every((n) => n === null)) return null;
  const [input = 0, written = 0, read = 0, output = 0] = counts.map((n) => n ?? 0);
  const split = (usage.cache_creation ?? {}) as Record<string, unknown>;
  const write5m = num(split.ephemeral_5m_input_tokens);
  const write1h = num(split.ephemeral_1h_input_tokens);
  const [short, long] = write5m === null && write1h === null ? [0, written] : [write5m ?? 0, write1h ?? 0];
  const prompt = input + written + read;
  const r = usage.speed === "fast" ? price.fast : price.long && prompt > price.long.tokens ? price.long.rates : price.rates;
  if (!r) return null;
  return (input * r.input + short * r.write5m + long * r.write1h + read * r.read + output * r.output) / 1_000_000;
}
