// Output-budget resolution shared by both protocol adapters (charter §4.2):
// the client's max_tokens / max_completion_tokens is validated first (a
// positive integer — 0 and negatives still 400), then lifted to the gateway
// floor `maxTokensDefault` (AGY_PROXY_MAX_TOKENS_DEFAULT, default 65_536).
// Small client caps truncate long answers mid-generation (finish 'length')
// — historically the dominant "healthy run" failure on the dashboard — and
// OpenAI SDKs commonly default to 1024/4096, so values below the floor are
// lifted and an omitted value gets the floor. floor 0 disables the mechanism
// entirely: the client value is honored exactly (an omitted OpenAI value
// stays uncapped), preserving the pre-floor behavior for exact-cap testing.
export function resolveEffectiveMaxTokens(
  client: number | undefined,
  floor: number,
): number | undefined {
  if (!(floor > 0)) return client
  return client === undefined ? floor : Math.max(client, floor)
}