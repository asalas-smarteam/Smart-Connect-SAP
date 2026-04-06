import hubspotAuthService from "./hubspotAuthService.js";
import objectTypeRouter from "./objectTypeRouter.js";
import * as hubspotClient from "./hubspotClient.js";
import { sapUpdateService } from "./sapUpdateService.js";
import dealMappingResolver from "./dealMappingResolver.js";
import { getMappedOwnerId } from "./ownerMapping.service.js";
import associationRegistryService from "./associationRegistryService.js";
import associationService from "./associationService.js";
import mappingService from "./mapping.service.js";
import axios from "axios";
import { getConnection } from "../utils/externalDb.js";
import { getWarehouseStockTotals } from "../utils/warehouseStock.js";

function slugCompanyName(companyName) {
  return String(companyName || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function generateFallbackEmail(baseEmail, companyName) {
  const normalizedEmail = String(baseEmail || '').trim().toLowerCase();

  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return null;
  }

  const [localPart, domain] = normalizedEmail.split('@');
  if (!localPart || !domain) {
    return null;
  }

  const companySlug = slugCompanyName(companyName) || 'company';

  return `${localPart}+${companySlug}@${domain}`;
}

const hubspotService = {
  async sendToHubSpot(mappedItems, clientConfig, objectType, tenantModels, credentials) {
    const token = await hubspotAuthService.getAccessToken(
      clientConfig.hubspotCredentialId,
      credentials,
      tenantModels
    );
    const handler = objectTypeRouter.getObjectTypeHandler(objectType);

    if (!handler) {
      throw new Error(`Unsupported object type: ${objectType}`);
    }

    let sent = 0;
    let failed = 0;

    for (const item of mappedItems) {
      const result = await this.processSingleItem(
        token,
        objectType,
        item,
        clientConfig,
        tenantModels
      );
      if (result.ok) {
        sent += 1;
      } else {
        failed += 1;
      }
    }

    return { ok: true, sent, failed };
  },

  async processSingleItem(token, objectType, item, clientConfig, tenantModels) {
    try {
      const handlers = {
        contact: {
          find: () => this.findContactByEmail(token, item?.properties?.email),
          update: (id) => this.updateContact(token, id, item),
          create: () => this.createContact(token, item),
        },

        company: {
          find: () => this.findCompanyByEmail(token, item?.properties?.email),
          update: (id) => this.updateCompany(token, id, item),
          create: () => this.createCompany(token, item),
        },

        deal: {
          preprocess: async () => {
            // Pipeline mapping
            const { pipeline, dealstage, hubspot_owner_id } =
              item.properties ?? {};

            const mappedPipeline = await dealMappingResolver.resolvePipeline(
              clientConfig.hubspotCredentialId,
              pipeline,
              tenantModels
            );
            if (!mappedPipeline) throw new Error("Pipeline mapping not found.");

            const mappedStage = await dealMappingResolver.resolveStage(
              clientConfig.hubspotCredentialId,
              pipeline,
              dealstage,
              tenantModels
            );
            if (!mappedStage) throw new Error("Stage mapping not found.");

            item.properties.pipeline = mappedPipeline.hubspotPipelineId;
            item.properties.dealstage = mappedStage.hubspotStageId;

            // Owner mapping
            const mappedOwner = await getMappedOwnerId(
              clientConfig.hubspotCredentialId,
              hubspot_owner_id,
              tenantModels
            );
            if (mappedOwner) item.properties.hubspot_owner_id = mappedOwner;
          },

          find: () => this.findDealByName(token, item?.properties?.dealname),
          update: (id) => this.updateDeal(token, id, item),
          create: () => this.createDeal(token, item),
        },

        product: {
          find: () => this.findProductBySKU(token, item?.properties?.hs_sku),
          update: (id) => this.updateProduct(token, id, item),
          create: () => this.createProduct(token, item),
          preprocess: async () => {
            const totals = getWarehouseStockTotals(
              item?.rawSapData?.ItemWarehouseInfoCollection
            );

            item.properties.ordered = totals.ordered;
            item.properties.committed = totals.committed;
            item.properties.instock = totals.instock;
            item.properties.available = totals.instock - totals.committed;
            item.properties.hs_price_usd = 0.00
          }
        },
      };

      // --- validar objeto soportado
      const handler = handlers[objectType];
      if (!handler) {
        throw new Error(`Unsupported object type: ${objectType}`);
      }

      // --- ejecutar preprocesamiento si existe
      if (handler.preprocess) {
        await handler.preprocess();
      }

      if(!item.properties.email && objectType !== 'product'){
        await associationRegistryService.registerBaseObjectMapping(
          clientConfig.hubspotCredentialId,
          objectType,
          item.properties.idsap,
          '',
          tenantModels
        );

        return { ok: true };
      }

      // --- buscar existente
      const existing = await handler.find();
      let created;

      if (existing) {
        await handler.update(existing.id);
      } else {
        created = await handler.create();
        await sapUpdateService.updateHubspotIdInSap(
          clientConfig,
          objectType,
          item?.properties ?? {},
          created?.id,
          tenantModels
        );

        const hubspotId = created?.id;
        const sapId = objectType === 'product'  ? item?.properties?.hs_sku : item?.properties?.idsap ;

        if (hubspotId && sapId) {
          await associationRegistryService.registerBaseObjectMapping(
            clientConfig.hubspotCredentialId,
            objectType,
            sapId,
            hubspotId,
            tenantModels
          );
        }
      }

      if (objectType === "contact") {
        const hubspotId = existing?.id ?? created?.id;

        if (hubspotId) {
          const associationsRoot = item?.properties?.associations || {};
          let associatedCompanies = associationsRoot.companies || [];

          if (
            associatedCompanies.length === 0 &&
            clientConfig.associationFetchEnabled
          ) {
            const fallback = await this.fetchAssociationsIfNeeded(
              clientConfig,
              "contact"
            );

            if (fallback) {
              associatedCompanies = fallback.companies || [];
            }
          }

          const companyAssociations = await this.resolveAssociationIds(
            clientConfig,
            "company",
            associatedCompanies,
            tenantModels
          );

          await associationService.associateContactWithCompanies(
            token,
            clientConfig.hubspotCredentialId,
            hubspotId,
            companyAssociations,
            tenantModels
          );
        }
      }

      if (objectType === "company") {
        const hubspotId = existing?.id ?? created?.id;

        if (hubspotId) {
          const associationsRoot = item?.properties?.associations || {};
          let associatedContacts = associationsRoot.contacts || [];

          if (
            associatedContacts.length === 0 &&
            clientConfig.associationFetchEnabled
          ) {
            const fallback = await this.fetchAssociationsIfNeeded(
              clientConfig,
              "company"
            );

            if (fallback) {
              associatedContacts = fallback.contacts || [];
            }
          }

          const contactAssociations = await this.resolveAssociationIds(
            clientConfig,
            "contact",
            associatedContacts,
            tenantModels
          );

          await associationService.associateCompanyWithContacts(
            token,
            clientConfig.hubspotCredentialId,
            hubspotId,
            contactAssociations,
            tenantModels
          );

          try {
            const sapContacts = item?.rawSapData?.ContactEmployees || [];

            if (Array.isArray(sapContacts) && sapContacts.length > 0) {
              const contactMappings = await mappingService.getMappingsByObjectType(
                clientConfig.hubspotCredentialId,
                "contact",
                "contactEmployee",
                tenantModels
              );

              if (!Array.isArray(contactMappings) || contactMappings.length === 0) {
                console.warn("No contactEmployee mappings found for company contact sync");
              }

              const mappedContacts = await mappingService.mapRecords(
                sapContacts,
                clientConfig.hubspotCredentialId,
                "contact",
                tenantModels,
                "contactEmployee"
              );

              for (const [index, mappedContact] of mappedContacts.entries()) {
                const sapContact = sapContacts[index] || {};
                const sapInternalCode = sapContact?.InternalCode;
                const contactPayload = {
                  ...mappedContact,
                  properties: {
                    ...(mappedContact?.properties || {}),
                  },
                };

                if (!contactPayload.properties.email) {
                  const fallbackEmail = generateFallbackEmail(
                    item?.rawSapData?.EmailAddress,
                    sapInternalCode
                  );

                  if (fallbackEmail) {
                    contactPayload.properties.email = fallbackEmail;
                  }
                }

                const existingContact = await this.findContactByEmail(
                  token,
                  contactPayload?.properties?.email
                );

                let createdContact;

                if (existingContact) {
                  await this.updateContact(token, existingContact.id, contactPayload);
                } else {
                  createdContact = await this.createContact(token, contactPayload);

                  if (createdContact?.id && sapInternalCode) {
                    await associationRegistryService.registerBaseObjectMapping(
                      clientConfig.hubspotCredentialId,
                      "contact",
                      sapInternalCode,
                      createdContact.id,
                      tenantModels
                    );
                  }
                }

                const contactHubspotId = existingContact?.id ?? createdContact?.id;

                if (contactHubspotId) {
                  await associationService.associateCompanyWithContacts(
                    token,
                    clientConfig.hubspotCredentialId,
                    hubspotId,
                    [{ hubspotId: contactHubspotId, sapId: sapInternalCode }],
                    tenantModels
                  );
                }
              }
            }
          } catch (contactSyncError) {
            console.error("Company contact sync error:", contactSyncError);
          }
        }
      }

      if (objectType === "deal") {
        const hubspotId = existing?.id ?? created?.id;

        if (hubspotId) {
          const associationsRoot = item?.properties?.associations || {};

          let associatedContacts = associationsRoot.contacts || [];
          let associatedCompanies = associationsRoot.companies || [];
          let associatedProducts = associationsRoot.products || [];

          if (
            associatedContacts.length === 0 &&
            associatedCompanies.length === 0 &&
            associatedProducts.length === 0 &&
            clientConfig.associationFetchEnabled
          ) {
            const fallback = await this.fetchAssociationsIfNeeded(
              clientConfig,
              "deal"
            );

            if (fallback) {
              associatedContacts = fallback.contacts || [];
              associatedCompanies = fallback.companies || [];
              associatedProducts = fallback.products || [];
            }
          }

          const contactAssociations = await this.resolveAssociationIds(
            clientConfig,
            "contact",
            associatedContacts,
            tenantModels
          );
          const companyAssociations = await this.resolveAssociationIds(
            clientConfig,
            "company",
            associatedCompanies,
            tenantModels
          );
          const productAssociations = await this.resolveAssociationIds(
            clientConfig,
            "product",
            associatedProducts,
            tenantModels
          );

          await associationService.associateDealWithContacts(
            token,
            clientConfig.hubspotCredentialId,
            hubspotId,
            contactAssociations,
            tenantModels
          );
          await associationService.associateDealWithCompanies(
            token,
            clientConfig.hubspotCredentialId,
            hubspotId,
            companyAssociations,
            tenantModels
          );
          await associationService.associateDealWithProducts(
            token,
            clientConfig.hubspotCredentialId,
            hubspotId,
            productAssociations,
            tenantModels
          );
        }
      }

      return { ok: true };
    } catch (error) {
      console.error("processSingleItem error:", error);
      return { ok: false };
    }
  },

  async findContactByEmail(token, email) {
    if (!email) {
      return null;
    }

    return hubspotClient.findContactByEmail(token, email);
  },

  async createContact(token, data) {
    const response = await hubspotClient.createContact(token, data);
    return response;
  },

  async updateContact(token, id, data) {
    return hubspotClient.updateContact(token, id, data);
  },

  async findCompanyByEmail(token, email) {
    if (!email) {
      return null;
    }

    return hubspotClient.findCompanyByEmail(token, email);
  },

  async createCompany(token, data) {
    const response = await hubspotClient.createCompany(token, data);
    return response;
  },

  async updateCompany(token, id, data) {
    return hubspotClient.updateCompany(token, id, data);
  },

  async findDealByName(token, dealName) {
    if (!dealName) {
      return null;
    }

    return hubspotClient.findDealByName(token, dealName);
  },

  async createDeal(token, data) {
    const response = await hubspotClient.createDeal(token, data);
    return response;
  },

  async updateDeal(token, id, data) {
    return hubspotClient.updateDeal(token, id, data);
  },

  async findProductBySKU(token, sku) {
    if (!sku) {
      return null;
    }

    return hubspotClient.findProductBySKU(token, sku);
  },

  async createProduct(token, data) {
    const response = await hubspotClient.createProduct(token, data);
    return response;
  },

  async updateProduct(token, id, data) {
    return hubspotClient.updateProduct(token, id, data);
  },

  async fetchAssociationsIfNeeded(clientConfig, objectType) {
    if (!clientConfig?.associationFetchEnabled) {
      return null;
    }

    const configArray = clientConfig.associationFetchConfig;

    if (!Array.isArray(configArray) || configArray.length === 0) {
      return null;
    }

    const associationTypes = this.getAssociationTypesForObject(objectType);

    if (associationTypes.length === 0) {
      return null;
    }

    const aggregated = {
      contacts: [],
      companies: [],
      products: [],
    };

    let hasConfig = false;

    for (const associationType of associationTypes) {
      const config = configArray.find(
        (entry) => entry?.objectType === associationType
      );

      if (!config) {
        continue;
      }

      hasConfig = true;
      const rawResult = await this.executeAssociationFetch(
        config,
        clientConfig
      );
      const normalized = this.normalizeAssociationValues(
        rawResult,
        associationType
      );

      const key =
        associationType === "contact"
          ? "contacts"
          : associationType === "company"
          ? "companies"
          : "products";

      aggregated[key] = normalized;
    }

    if (!hasConfig) {
      return null;
    }

    return aggregated;
  },

  getAssociationTypesForObject(objectType) {
    if (objectType === "deal") {
      return ["contact", "company", "product"];
    }

    if (objectType === "contact") {
      return ["company"];
    }

    if (objectType === "company") {
      return ["contact"];
    }

    return [];
  },

  async executeAssociationFetch(config, clientConfig) {
    const fetchType = config?.associationFetchType;
    const fetchConfig = config?.associationFetchConfig;

    if (!fetchType || !fetchConfig) {
      return {};
    }

    if (fetchType === "api") {
      const response = await axios({
        method: fetchConfig.method || "GET",
        url: fetchConfig.url,
      });

      return response?.data ?? response;
    }

    if (fetchType === "sp") {
      const storedProcedure =
        fetchConfig.storedProcedure || fetchConfig.storeProcedureName;

      if (!storedProcedure) {
        return {};
      }

      const externalSequelize = getConnection(clientConfig);
      const [results] = await externalSequelize.query(`EXEC ${storedProcedure}`);

      return results ?? {};
    }

    return {};
  },

  normalizeAssociationValues(rawResult, associationType) {
    const key =
      associationType === "contact"
        ? "contacts"
        : associationType === "company"
        ? "companies"
        : "products";

    if (Array.isArray(rawResult)) {
      return rawResult;
    }

    if (!rawResult || typeof rawResult !== "object") {
      return [];
    }

    if (Array.isArray(rawResult[key])) {
      return rawResult[key];
    }

    if (Array.isArray(rawResult[associationType])) {
      return rawResult[associationType];
    }

    return [];
  },

  async resolveAssociationIds(clientConfig, objectType, associationValues, tenantModels) {
    if (!Array.isArray(associationValues)) {
      return [];
    }

    const hubspotCredentialId = clientConfig?.hubspotCredentialId;
    const isProduct = objectType === "product";
    const resolved = [];

    for (const value of associationValues) {
      const sapId = value?.sapId ?? value;
      const quantity = value?.qty ?? value?.quantity ?? null;

      const hubspotId = await associationRegistryService.findHubspotIdForSapId(
        hubspotCredentialId,
        objectType,
        sapId ? String(sapId) : null,
        tenantModels
      );

      if (isProduct) {
        resolved.push({ hubspotId, sapId, qty: quantity });
      } else {
        resolved.push({ hubspotId, sapId });
      }
    }

    return resolved;
  },
};

export default hubspotService;
