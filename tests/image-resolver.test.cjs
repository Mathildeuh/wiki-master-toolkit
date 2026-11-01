const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadResolverModule() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'features', 'image-resolver.js'), 'utf8');
  const sandbox = {
    window: {},
    URLSearchParams,
    fetch: null,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.__wmAverageFeatures.imageResolver;
}

test('imageResolver: returns cached entry when still valid', async () => {
  const factory = loadResolverModule();
  const storage = new Map();
  storage.set('prefix_test', {
    fetchedAt: Date.now() - 1000,
    found: true,
    url: 'https://upload.wikimedia.org/test.png'
  });

  const resolver = factory.create({
    normalizeTitle: (t) => t.trim().toLowerCase(),
    readLocalValue: (k) => storage.get(k),
    writeLocalValue: (k, v) => storage.set(k, v),
    MISSING_IMAGE_CACHE_PREFIX: 'prefix_',
    MISSING_IMAGE_FOUND_TTL: 60 * 1000,
    MISSING_IMAGE_MISS_TTL: 10 * 1000
  });

  const res = await resolver.resolveMissingImage('test');
  assert.equal(res.found, true);
  assert.equal(res.url, 'https://upload.wikimedia.org/test.png');
});

test('imageResolver: ignores expired miss cache and retries fresh', async () => {
  const factory = loadResolverModule();
  const storage = new Map();
  // Cached miss 20 seconds ago, with miss TTL 10 seconds -> should be expired
  storage.set('prefix_pikachu', {
    fetchedAt: Date.now() - 20 * 1000,
    found: false
  });

  let fetchCalled = false;
  const mockFetch = async (url) => {
    fetchCalled = true;
    return {
      status: 404,
      ok: false
    };
  };

  // Run in a context with mock fetch
  const code = fs.readFileSync(path.join(__dirname, '..', 'features', 'image-resolver.js'), 'utf8');
  const sandbox = {
    window: {},
    URLSearchParams,
    fetch: mockFetch,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const resolver = sandbox.window.__wmAverageFeatures.imageResolver.create({
    normalizeTitle: (t) => t.trim().toLowerCase(),
    readLocalValue: (k) => storage.get(k),
    writeLocalValue: (k, v) => storage.set(k, v),
    MISSING_IMAGE_CACHE_PREFIX: 'prefix_',
    MISSING_IMAGE_FOUND_TTL: 60 * 1000,
    MISSING_IMAGE_MISS_TTL: 10 * 1000
  });

  const res = await resolver.resolveMissingImage('pikachu');
  assert.equal(fetchCalled, true);
  assert.equal(res.found, false);
});
