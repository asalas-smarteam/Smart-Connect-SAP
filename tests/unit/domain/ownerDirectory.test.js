import {
  createOwnerDirectory,
  isOwnerFieldMapping,
  parseSapOwnerIds,
  resolveHubspotOwnerId,
  translateSapOwnerValue,
} from '../../../src/domain/owners/owner-directory.service.js';

const ROWS = [
  { sapOwnerId: '600', hubspotOwnerId: '123123123', active: true },
  // Caso real de B1: la misma persona tiene un SalesPersonCode por sucursal y
  // los tres tienen que llegar al mismo owner de HubSpot.
  { sapOwnerId: '113,758,864', hubspotOwnerId: '91123123', active: true },
  // Fila que el seed de HubSpot creó y nadie homologó todavía: no puede aportar
  // equivalencia.
  { sapOwnerId: null, hubspotOwnerId: '9072589', active: true },
  { sapOwnerId: '999', hubspotOwnerId: '77777777', active: false },
];

describe('parseSapOwnerIds', () => {
  it('parte el CSV y tolera espacios y entradas vacías', () => {
    expect(parseSapOwnerIds('100,200,300')).toEqual(['100', '200', '300']);
    expect(parseSapOwnerIds(' 100 , 200 ,, 300 ,')).toEqual(['100', '200', '300']);
  });

  // Un solo código es el mismo formato con una sola entrada: no hay dos casos
  // que mantener.
  it('trata un código único como una lista de uno', () => {
    expect(parseSapOwnerIds('600')).toEqual(['600']);
    expect(parseSapOwnerIds(600)).toEqual(['600']);
  });

  it('devuelve lista vacía para valores sin contenido', () => {
    expect(parseSapOwnerIds(null)).toEqual([]);
    expect(parseSapOwnerIds('')).toEqual([]);
    expect(parseSapOwnerIds('  ,  ')).toEqual([]);
  });
});

describe('createOwnerDirectory', () => {
  it('indexa cada código del CSV hacia el mismo owner de HubSpot', () => {
    const directory = createOwnerDirectory(ROWS);

    for (const code of ['113', '758', '864']) {
      expect(resolveHubspotOwnerId(directory, code)).toBe('91123123');
    }
  });

  it('descarta filas sin homologar o inactivas', () => {
    const directory = createOwnerDirectory(ROWS);

    expect(directory.size).toBe(4);
    expect(resolveHubspotOwnerId(directory, '600')).toBe('123123123');
    expect(resolveHubspotOwnerId(directory, '9072589')).toBeNull();
    expect(resolveHubspotOwnerId(directory, '999')).toBeNull();
  });

  // SAP entrega SalesPersonCode como número y OwnerMappings lo guarda como
  // texto: sin normalizar, la búsqueda falla por tipo y el 600 se iría crudo.
  it('resuelve un código numérico de SAP contra el sapOwnerId guardado como texto', () => {
    const directory = createOwnerDirectory(ROWS);

    expect(resolveHubspotOwnerId(directory, 600)).toBe('123123123');
    expect(resolveHubspotOwnerId(directory, ' 600 ')).toBe('123123123');
  });

  it('tolera entradas vacías', () => {
    expect(createOwnerDirectory(null).size).toBe(0);
    expect(createOwnerDirectory([{}]).size).toBe(0);
  });
});

describe('isOwnerFieldMapping', () => {
  it('solo acepta userField exactamente true', () => {
    expect(isOwnerFieldMapping({ userField: true })).toBe(true);
    // Un 'true' string guardado a mano no cuenta: la normalización pasa por la
    // API de mapeos, y aceptarlo acá esconderia un documento mal escrito.
    expect(isOwnerFieldMapping({ userField: 'true' })).toBe(false);
    expect(isOwnerFieldMapping({ userField: false })).toBe(false);
    expect(isOwnerFieldMapping({})).toBe(false);
    expect(isOwnerFieldMapping(null)).toBe(false);
  });
});

describe('translateSapOwnerValue (SAP -> HubSpot)', () => {
  const directory = createOwnerDirectory(ROWS);

  it('devuelve el ownerId de HubSpot cuando hay homologación', () => {
    expect(translateSapOwnerValue({ value: '600', directory })).toEqual({
      status: 'resolved',
      value: '123123123',
    });
  });

  // Es el caso del 600 = 'INHABILITADO TMK' del tenant printer: un código que
  // no es una persona y nunca va a tener owner en HubSpot.
  it('marca unresolved un código de SAP sin homologar', () => {
    expect(translateSapOwnerValue({ value: '777', directory }).status).toBe('unresolved');
  });

  it('deja pasar un valor vacío sin tocarlo', () => {
    expect(translateSapOwnerValue({ value: '', directory })).toEqual({
      status: 'passthrough',
      value: '',
    });
    expect(translateSapOwnerValue({ value: null, directory }).status).toBe('passthrough');
  });
});
