'use strict';

const {
  LIMIT_PROVIDER_CATALOG_GENERATION,
  limitProvidersAddedAfter,
  limitProvidersForDetectedClients
} = require('../shared/limitProviders');

function healthClientsOf(summary) {
  const healthClients = summary?.clientHealth?.clients;
  return healthClients && typeof healthClients === 'object' && !Array.isArray(healthClients)
    ? healthClients
    : null;
}

function persistOrRestore(deps, restore) {
  try {
    if (deps.saveSettings?.() !== true) {
      restore();
      return false;
    }
  } catch (error) {
    restore();
    throw error;
  }
  return true;
}

function applyInitialLimitProviderSeed(pending, summary, deps = {}) {
  if (!pending || !deps.settings || !healthClientsOf(summary)) return false;

  const previousProviders = deps.settings.limitProviders;
  const previousGeneration = deps.settings.limitProviderCatalogGeneration;
  const detectedProviders = limitProvidersForDetectedClients(summary.clientHealth);
  // Keep the Limits view discoverable on a source-free first run.
  deps.settings.limitProviders = (detectedProviders.length > 0 ? detectedProviders : ['codex']).join(',');
  // A fresh install has seen every provider the seed could choose from.
  deps.settings.limitProviderCatalogGeneration = LIMIT_PROVIDER_CATALOG_GENERATION;
  const persisted = persistOrRestore(deps, () => {
    deps.settings.limitProviders = previousProviders;
    deps.settings.limitProviderCatalogGeneration = previousGeneration;
  });
  if (!persisted) return false;

  deps.onPersisted?.();
  return true;
}

// A provider wired after this install first ran is enabled exactly once, on the
// first discovery snapshot that detects its local source, and the install then
// records the catalog generation so a later manual "off" stays off. Providers
// the user already chose are never touched.
function applyNewLimitProviderSeed(summary, deps = {}) {
  if (!deps.settings || !healthClientsOf(summary)) return false;
  const seenGeneration = Number(deps.settings.limitProviderCatalogGeneration) || 1;
  if (seenGeneration >= LIMIT_PROVIDER_CATALOG_GENERATION) return false;

  const enabled = String(deps.settings.limitProviders || '')
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  const detected = new Set(limitProvidersForDetectedClients(summary.clientHealth));
  const additions = limitProvidersAddedAfter(seenGeneration)
    .filter((id) => detected.has(id) && !enabled.includes(id));

  const previousProviders = deps.settings.limitProviders;
  const previousGeneration = deps.settings.limitProviderCatalogGeneration;
  if (additions.length > 0) deps.settings.limitProviders = [...enabled, ...additions].join(',');
  deps.settings.limitProviderCatalogGeneration = LIMIT_PROVIDER_CATALOG_GENERATION;
  const persisted = persistOrRestore(deps, () => {
    deps.settings.limitProviders = previousProviders;
    deps.settings.limitProviderCatalogGeneration = previousGeneration;
  });
  if (!persisted || additions.length === 0) return false;

  deps.onPersisted?.();
  return true;
}

module.exports = {
  applyInitialLimitProviderSeed,
  applyNewLimitProviderSeed
};
