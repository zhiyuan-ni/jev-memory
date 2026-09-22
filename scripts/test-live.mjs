import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Proxy initialization must happen before Node starts the Vitest workers.
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 5)) {
  throw new Error('test:live requires Node >=24.5 for native fetch proxy support.');
}
try {
  process.loadEnvFile('.env');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!process.env.AIHUBMIX_API_KEY || process.env.AIHUBMIX_API_KEY === 'test-aihubmix-key') {
  throw new Error('Set AIHUBMIX_API_KEY in .env or the environment before running test:live.');
}
const env = { ...process.env, NODE_USE_ENV_PROXY: '1' };
if (!env.HTTPS_PROXY && !env.https_proxy && process.platform === 'darwin') {
  try {
    const settings = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8' });
    const enabled = /HTTPSEnable\s*:\s*1/.test(settings);
    const host = settings.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
    const port = settings.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
    if (enabled && host && port) {
      env.HTTPS_PROXY = `http://${host}:${port}`;
      console.log('Using the enabled macOS HTTPS proxy for live tests.');
    }
  } catch {
    // Explicit proxy environment variables remain supported on all platforms.
  }
}
if (env.HTTPS_PROXY || env.https_proxy) {
  console.log('Node proxy support enabled for Vitest and its workers.');
} else {
  console.log('No HTTPS proxy configured; live tests will connect directly.');
}
const result = spawnSync(process.execPath, ['./node_modules/vitest/vitest.mjs', 'run', 'test/live.test.ts'], {
  env, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
