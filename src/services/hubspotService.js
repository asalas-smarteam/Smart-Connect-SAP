import hubspotAuthService from "./hubspotAuthService.js";
import objectTypeRouter from "./objectTypeRouter.js";
import * as hubspotClient from "./hubspotClient.js";
import { sapUpdateService } from "./sapUpdateService.js";
import dealMappingResolver from "./dealMappingResolver.js";
import { getMappedOwnerId } from "./dealOwnerMapping.service.js";

const hubspotService = {
  async sendToHubSpot(mappedItems, clientConfig, objectType) {
    const token = await hubspotAuthService.getAccessToken(
      clientConfig.hubspotCredentialId
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
        clientConfig
      );
      if (result.ok) {
        sent += 1;
      } else {
        failed += 1;
      }
    }

    return { ok: true, sent, failed };
  },

  async processSingleItem(token, objectType, item, clientConfig) {
    try {
      const handlers = {
        contact: {
          find: () => this.findContactByEmail(token, item?.properties?.email),
          update: (id) => this.updateContact(token, id, item),
          create: () => this.createContact(token, item),
        },

        company: {
          find: () => this.findCompanyByDomain(token, item?.properties?.domain),
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
              pipeline
            );
            if (!mappedPipeline) throw new Error("Pipeline mapping not found.");

            const mappedStage = await dealMappingResolver.resolveStage(
              clientConfig.hubspotCredentialId,
              pipeline,
              dealstage
            );
            if (!mappedStage) throw new Error("Stage mapping not found.");

            item.properties.pipeline = mappedPipeline.hubspotPipelineId;
            item.properties.dealstage = mappedStage.hubspotStageId;

            // Owner mapping
            const mappedOwner = await getMappedOwnerId(
              clientConfig.hubspotCredentialId,
              hubspot_owner_id
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

      // --- buscar existente
      const existing = await handler.find();

      if (existing) {
        await handler.update(existing.id);
      } else {
        const created = await handler.create();
        await sapUpdateService.updateHubspotIdInSap(
          clientConfig,
          objectType,
          item?.properties ?? {},
          created?.id
        );
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

  async findCompanyByDomain(token, domain) {
    if (!domain) {
      return null;
    }

    return hubspotClient.findCompanyByDomain(token, domain);
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
};

export default hubspotService;
