import { createPort } from '../port-validator.js';

// Construcción del payload del documento. Cada flavor habla su propio modelo de entidades
// (B1 `CardCode`/`DocumentLines` vs S/4 `SoldToParty`/`to_Item`).
export const SalesDocumentBuilderPort = createPort({
  name: 'SalesDocumentBuilderPort',
  methods: [
    // buildQuotationPayload(args) -> payload listo para el adapter del mismo flavor
    'buildQuotationPayload',
  ],
});

export default SalesDocumentBuilderPort;
