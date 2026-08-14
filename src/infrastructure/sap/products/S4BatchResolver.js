// Trae el maestro de lotes de S/4 en una sola conversacion paginada. A
// diferencia de S4StockResolver -- que particiona por centro porque Plant es
// campo clave de A_MatlStkInAcctMod y filtra selectivamente en el indice ABAP --
// el maestro de lotes NO tiene centro: se verificaron los 74,277 lotes de este
// sistema y BatchIdentifyingPlant es "" en todos.
//
// Costo medido contra el S/4 de QA: 74,277 filas en 319 segundos. Es caro, y es
// deliberado: filtrar por ShelfLifeExpirationDate >= hoy bajaria a 21,397 filas
// (~90 s) pero dejaria fuera los vencidos, y la propiedad cantidad_vencida es
// justamente la senal de que hay inventario para depurar (decision D6 del spec).
export const BATCH_MASTER_PATH = '/API_BATCH_SRV/Batch';

export const BATCH_MASTER_SELECT = [
  'Material',
  // Se pide aunque hoy sea siempre "": el dia que activen lotes a nivel centro,
  // este campo deja de ser vacio y el join Material+Batch pasa a ser ambiguo
  // (buildBatchIndex indexa por `material|batch` y gana la ultima fila, o sea
  // que se quedaria con la fecha de un centro arbitrario, en silencio).
  // fetchBatchRows lo audita y emite UN warn por corrida si aparece no vacio.
  'BatchIdentifyingPlant',
  'Batch',
  'ShelfLifeExpirationDate',
  'ManufactureDate',
].join(',');

export class S4BatchResolver {
  constructor({ transport, logger = console }) {
    if (!transport) {
      throw new Error('transport is required for S4BatchResolver');
    }
    this.transport = transport;
    this.logger = logger;
  }

  async fetchBatchRows() {
    const rows = await this.transport.fetchAll({
      path: BATCH_MASTER_PATH,
      query: { $select: BATCH_MASTER_SELECT },
    });

    const batchRows = (Array.isArray(rows) ? rows : []).filter(Boolean);

    // UN warn por corrida, no uno por fila: son ~74k filas y el dato que
    // importa es que la suposicion del join dejo de valer, no cual fila lo
    // delata. Se corre sobre el set completo porque fetchBatchRows se invoca
    // una sola vez por sync.
    const plantScopedRows = batchRows.filter(
      (row) => String(row?.BatchIdentifyingPlant ?? '').trim()
    );

    if (plantScopedRows.length > 0) {
      const [sample] = plantScopedRows;
      this.logger?.warn?.(
        'Batch master rows carry a BatchIdentifyingPlant: the Material+Batch join is now ambiguous and expiry dates may be taken from an arbitrary plant',
        {
          rowsWithPlant: plantScopedRows.length,
          totalRows: batchRows.length,
          sample: {
            material: sample?.Material,
            batch: sample?.Batch,
            plant: sample?.BatchIdentifyingPlant,
          },
        }
      );
    }

    return batchRows;
  }
}

export default S4BatchResolver;
