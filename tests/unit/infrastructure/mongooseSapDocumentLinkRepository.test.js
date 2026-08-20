import { jest } from '@jest/globals';
import MongooseSapDocumentLinkRepository from '../../../src/infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js';

describe('MongooseSapDocumentLinkRepository.findByOrderDocEntry', () => {
  const repository = new MongooseSapDocumentLinkRepository();

  function buildModel(result) {
    const lean = jest.fn().mockResolvedValue(result);
    const findOne = jest.fn().mockReturnValue({ lean });
    return { model: { findOne }, findOne, lean };
  }

  it('busca el link de la orden por hubspotCredentialId, documentType y sapDocEntry', async () => {
    const { model, findOne } = buildModel({ dealId: '64175519381' });

    const link = await repository.findByOrderDocEntry({
      SapDocumentLink: model,
      hubspotCredentialId: 'cred-1',
      sapDocEntry: 28987,
    });

    expect(findOne).toHaveBeenCalledWith({
      hubspotCredentialId: 'cred-1',
      documentType: 'order',
      sapDocEntry: 28987,
    });
    expect(link).toEqual({ dealId: '64175519381' });
  });

  // Un BaseEntry basura no debe convertirse en una consulta con sapDocEntry: NaN, que en
  // Mongo no matchea nada pero recorre el indice igual.
  it('devuelve null sin consultar cuando el sapDocEntry no es un entero', async () => {
    const { model, findOne } = buildModel({ dealId: 'x' });

    await expect(repository.findByOrderDocEntry({
      SapDocumentLink: model,
      hubspotCredentialId: 'cred-1',
      sapDocEntry: Number.NaN,
    })).resolves.toBeNull();

    expect(findOne).not.toHaveBeenCalled();
  });

  it('devuelve null sin consultar cuando no hay modelo', async () => {
    await expect(repository.findByOrderDocEntry({
      SapDocumentLink: null,
      hubspotCredentialId: 'cred-1',
      sapDocEntry: 1,
    })).resolves.toBeNull();
  });
});
