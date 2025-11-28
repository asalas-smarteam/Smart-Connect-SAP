import hubspotAuthService from './hubspotAuthService.js';
import objectTypeRouter from './objectTypeRouter.js';
import * as hubspotClient from './hubspotClient.js';

const hubspotService = {
  async sendToHubSpot(mappedItems, clientConfig, objectType) {
    const token = await hubspotAuthService.getAccessToken(clientConfig.hubspotCredentialId);
    const handler = objectTypeRouter.getObjectTypeHandler(objectType);

    if (!handler) {
      throw new Error(`Unsupported object type: ${objectType}`);
    }

    let sent = 0;
    let failed = 0;

    for (const item of mappedItems) {
      const result = await this.processSingleItem(token, objectType, item);
      if (result.ok) {
        sent += 1;
      } else {
        failed += 1;
      }
    }

    return { ok: true, sent, failed };
  },

  async processSingleItem(token, objectType, item) {
    try {
      if (objectType === 'contact') {
        const existing = await this.findContactByEmail(token, item?.properties?.email);

        if (existing) {
          await this.updateContact(token, existing.id, item);
        } else {
          await this.createContact(token, item);
        }

        return { ok: true };
      }

      if (objectType === 'company') {
        const existing = await this.findCompanyByDomain(token, item?.properties?.domain);

        if (existing) {
          await this.updateCompany(token, existing.id, item);
        } else {
          await this.createCompany(token, item);
        }

        return { ok: true };
      }

      if (objectType === 'deal') {
        const existing = await this.findDealByName(token, item?.properties?.dealname);

        if (existing) {
          await this.updateDeal(token, existing.id, item);
        } else {
          await this.createDeal(token, item);
        }

        return { ok: true };
      }

      throw new Error(`Unsupported object type: ${objectType}`);
    } catch (error) {
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
    return hubspotClient.createContact(token, data);
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
    return hubspotClient.createCompany(token, data);
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
    return hubspotClient.createDeal(token, data);
  },

  async updateDeal(token, id, data) {
    return hubspotClient.updateDeal(token, id, data);
  },
};

export default hubspotService;
