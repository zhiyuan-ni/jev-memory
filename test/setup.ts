// Load a local developer key for the opt-in live suite. Vitest does not load
// `.env` into process.env by itself when invoked directly.
try {
  process.loadEnvFile('.env');
} catch (error: unknown) {
  if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
}

// Provide a fake key for mocked System One calls without replacing a real key.
process.env.AIHUBMIX_API_KEY ??= 'test-aihubmix-key';
