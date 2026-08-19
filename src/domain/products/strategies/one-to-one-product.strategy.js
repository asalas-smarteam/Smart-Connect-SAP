import {
  KEEP_MAPPED_PRICE_FLAG,
  PRODUCT_PRICE_SOURCES,
  PRODUCT_SYNC_STRATEGIES,
  RESOLVED_PRODUCT_PRICE_KEY,
} from '../product-sync-strategy.constants.js';
import {
  normalizeProductPriceSource,
  resolveProductPriceFromItemPrices,
} from '../product-price-source.service.js';

function markRecordToKeepMappedPrice(record) {
  return {
    ...record,
    rawSapData: {
      ...(record?.rawSapData ?? {}),
      [KEEP_MAPPED_PRICE_FLAG]: true,
    },
  };
}

function removeMappedField(record, field) {
  const properties = { ...(record?.properties ?? {}) };
  delete properties[field];
  return { ...record, properties };
}

// Currencies (fieldsPricesHS) and cost field are mapped from SAP by the mapping
// repository. Here we only decide which of them survive to HubSpot:
// - keepMappedPrice: keep currency values instead of letting the handler zero them.
// - dropCostField: drop the cost field so it is not inserted.
function applyPriceAndCostConfig(record, { keepMappedPrice, dropCostField, costField }) {
  let result = keepMappedPrice ? markRecordToKeepMappedPrice(record) : record;

  if (dropCostField && costField) {
    result = removeMappedField(result, costField);
  }

  return result;
}

// Adjunta el precio resuelto bajo rawSapData. Setea las DOS llaves a proposito:
// selectedPrice porque es la guarda que ya existe en product.handler.js y otros
// consumidores podrian leerla, y RESOLVED_PRODUCT_PRICE_KEY porque selectedPrice
// es la fila cruda y el handler necesita el numero ya elegido segun priceField.
// Si no hay precio para la lista devuelve el record intacto: el handler lo cera,
// que es el comportamiento SET_ZERO.
function applyResolvedItemPrice(record, { priceList, priceField }) {
  const resolved = resolveProductPriceFromItemPrices({
    itemPrices: record?.rawSapData?.ItemPrices,
    priceList,
    priceField,
  });

  if (!resolved) {
    return record;
  }

  return {
    ...record,
    rawSapData: {
      ...(record?.rawSapData ?? {}),
      selectedPrice: resolved.row,
      [RESOLVED_PRODUCT_PRICE_KEY]: resolved.price,
    },
  };
}

export class OneToOneProductStrategy {
  constructor({ hubspotSyncTarget, priceListConfigRepository = null, logger = console }) {
    this.hubspotSyncTarget = hubspotSyncTarget;
    this.priceListConfigRepository = priceListConfigRepository;
    this.logger = logger;
  }

  // Lee la config priceList UNA vez por corrida, no por producto.
  // resolveTenantPriceList lanza cuando la config falta o su formato es
  // invalido; aca eso no puede tumbar la corrida. Si se dejara propagar, el
  // try/catch de execute() lo convertiria en failed: totalProducts y el tenant
  // perderia tambien nombre y stock, no solo el precio. Devolver null = caer a
  // SET_ZERO, mismo criterio que los enrichers.
  async resolvePriceList({ tenantContext, tenantId }) {
    if (typeof this.priceListConfigRepository?.resolveTenantPriceList !== 'function') {
      this.logger.warn?.({
        msg: 'requirePrice.source.from es itemPrices pero no hay priceListConfigRepository inyectado',
        tenantId,
      });
      return null;
    }

    try {
      return await this.priceListConfigRepository.resolveTenantPriceList({
        tenantModels: tenantContext?.tenantModels,
      });
    } catch (error) {
      this.logger.error?.({
        msg: 'No se pudo resolver la lista de precios del tenant; los precios quedan en 0',
        tenantId,
        error: error.message,
      });
      return null;
    }
  }

  async execute({
    mappedRecords,
    config,
    objectType,
    tenantContext,
    credentials,
    tenantId,
    strategyConfig = {},
  }) {
    const records = Array.isArray(mappedRecords) ? mappedRecords : [];
    const totalProducts = records.length;
    const requirePriceValue = strategyConfig.requirePrice?.value;
    const requireCostFlag = strategyConfig.requireCost?.flag;
    const costField = strategyConfig.requireCost?.field;
    const priceSource = normalizeProductPriceSource(strategyConfig.requirePrice, {
      logger: this.logger,
    });
    const priceComesFromItemPrices = priceSource.from === PRODUCT_PRICE_SOURCES.ITEM_PRICES;
    // null cubre los dos casos en los que no hay que resolver nada: la fuente es
    // 'mapped', o la config del tenant no se pudo leer.
    const resolvedPriceList = priceComesFromItemPrices
      ? await this.resolvePriceList({ tenantContext, tenantId })
      : null;
    // requirePrice.value y source.from responden preguntas distintas: "quiero un
    // precio" vs "de donde sale". Cuando source.from es itemPrices, la resolucion
    // gana (asi lo define el spec) y keepMappedPrice NO se aplica, sin importar si
    // la lista se pudo resolver o no: si se aplicara en el caso de fallo,
    // resucitaria el precio de la corrida anterior, que es justo el bug que
    // SET_ZERO existe para evitar.
    const keepMappedPrice = Boolean(requirePriceValue) && !priceComesFromItemPrices;

    if (requirePriceValue && priceComesFromItemPrices) {
      this.logger.warn?.({
        msg: 'requirePrice.value se ignora: requirePrice.source.from declara itemPrices y la resolucion gana',
        tenantId,
      });
    }

    // Solo tiene sentido hablar de "resuelta o no" cuando efectivamente se
    // intento resolver (source itemPrices). Para 'mapped' no hay nada que
    // resolver, asi que no cuenta como una resolucion fallida.
    const priceListResolved = priceComesFromItemPrices ? resolvedPriceList !== null : true;
    let productsWithoutPrice = 0;

    const recordsToSend = records.map((record) => {
      const base = applyPriceAndCostConfig(record, {
        keepMappedPrice,
        dropCostField: !requireCostFlag,
        costField,
      });

      if (resolvedPriceList === null) {
        return base;
      }

      const withPrice = applyResolvedItemPrice(base, {
        priceList: resolvedPriceList,
        priceField: priceSource.priceField,
      });

      if (withPrice === base) {
        productsWithoutPrice += 1;
      }

      return withPrice;
    });

    this.logger.info?.({
      msg: 'Starting product sync strategy',
      tenantId,
      strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT,
      totalProducts,
      requirePrice: requirePriceValue,
      requireCost: requireCostFlag,
      costField,
      priceSource: priceSource.from,
      priceList: resolvedPriceList,
      priceListResolved,
      productsWithoutPrice,
    });

    try {
      const result = await this.hubspotSyncTarget.send({
        mappedRecords: recordsToSend,
        config,
        objectType,
        tenantContext,
        credentials,
      });

      this.logger.info?.({
        msg: 'Finished product sync strategy',
        tenantId,
        strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT,
        totalProducts,
        sent: result?.sent ?? 0,
        failed: result?.failed ?? 0,
      });

      return {
        sent: result?.sent ?? 0,
        failed: result?.failed ?? 0,
        created: result?.created ?? 0,
        updated: result?.updated ?? Math.max((result?.sent ?? 0) - (result?.created ?? 0), 0),
        errors: Array.isArray(result?.errors) ? result.errors : [],
        recordsProcessed: totalProducts,
      };
    } catch (error) {
      this.logger.error?.({
        msg: 'Product sync strategy failed',
        tenantId,
        strategy: PRODUCT_SYNC_STRATEGIES.ONE_TO_ONE_PRODUCT,
        totalProducts,
        error: error.message,
      });

      return {
        sent: 0,
        failed: totalProducts,
        created: 0,
        updated: 0,
        recordsProcessed: totalProducts,
      };
    }
  }
}

export default OneToOneProductStrategy;
