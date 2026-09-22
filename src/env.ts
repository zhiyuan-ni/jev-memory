/** Ensures the native AIHubMix System One endpoint has a server-side key. */
export function assertAuthConfigured(): string {
  const apiKey = process.env.AIHUBMIX_API_KEY;
  if (apiKey) return apiKey;

  throw new Error(
    'jev-memory: no AIHubMix credentials found. Set AIHUBMIX_API_KEY to an API key from ' +
      'https://aihubmix.com before calling Jev.',
  );
}
