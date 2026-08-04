// Opt-in per tenant. Turning the chain on changes how duplicate targetField
// mappings behave, so it must never switch on by itself for a tenant that has
// not asked for it.
export const MAPPING_FALLBACK_CONFIG_KEY = 'mappingFallback';

// Which row of a collection navigation wins, e.g.
//   {
//     "to_BusinessPartnerTax": {
//       "field": "BPTaxType",
//       "order": ["DO1", "CR1", "GT1", "DO5"]
//     }
//   }
// Needed because a BP can carry several tax rows and Gateway does not guarantee
// their order, so "the first one" is not a decision anyone made.
export const MAPPING_COLLECTION_PRIORITY_CONFIG_KEY = 'mappingCollectionPriority';

async function readConfiguration(Configuration, key) {
  if (typeof Configuration?.findOne !== 'function') {
    return null;
  }

  const query = Configuration.findOne({ key });
  const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;

  return configuration?.value ?? null;
}

function normalizePriority(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const entries = Object.entries(value).filter(
    ([, rule]) => rule?.field && Array.isArray(rule?.order) && rule.order.length > 0
  );

  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export class MappingFallbackConfigRepository {
  // Never throws: a config read failure must not stop a sync, it just means the
  // legacy behaviour stays in effect.
  async getMappingFallbackConfig({ tenantModels, tenantContext } = {}) {
    const Configuration = tenantModels?.Configuration ?? tenantContext?.tenantModels?.Configuration;

    try {
      const enabled = await readConfiguration(Configuration, MAPPING_FALLBACK_CONFIG_KEY);

      if (enabled !== true) {
        return { enabled: false, collectionPriority: null };
      }

      return {
        enabled: true,
        collectionPriority: normalizePriority(
          await readConfiguration(Configuration, MAPPING_COLLECTION_PRIORITY_CONFIG_KEY)
        ),
      };
    } catch (error) {
      console.error('Mapping fallback config read error:', error);
      return { enabled: false, collectionPriority: null };
    }
  }
}

export default MappingFallbackConfigRepository;
