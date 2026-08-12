import { jest } from '@jest/globals';
import PropertiesFlagsEnrichmentAdapter
  from '../../../src/infrastructure/sap/customers/PropertiesFlagsEnrichmentAdapter.js';
import BusinessPartnerCreationConfigRepository
  from '../../../src/infrastructure/config/BusinessPartnerCreationConfigRepository.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';
import { SapRecordEnricherPort } from '../../../src/application/ports/sap/sap-record-enricher.port.js';

describe('cableado del enricher de PropertiesN', () => {
  it('el adapter cableado con su repositorio real cumple el puerto', () => {
    const adapter = new PropertiesFlagsEnrichmentAdapter({
      configRepository: new BusinessPartnerCreationConfigRepository(),
      logger: { warn: jest.fn(), error: jest.fn() },
    });

    expect(() => assertPort(adapter, SapRecordEnricherPort)).not.toThrow();
  });
});
