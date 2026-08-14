import { createPort } from '../port-validator.js';

// Como se representan en HubSpot los lotes ya normalizados. Eje ORTOGONAL al de
// la fuente: el mismo s4_BatchMaster alimenta tanto propiedades del producto
// como, en un portal Enterprise, un custom object asociado.
export const ProductBatchProjectionPort = createPort({
  name: 'ProductBatchProjectionPort',
  methods: [
    // (config) -> descriptores de lo que hay que asegurar en el portal antes
    // del primer run. Una proyeccion a custom object declararia aqui su esquema.
    'requiredProperties',
    // ({ record, batches, config }) -> { [propertyName]: value }
    'project',
  ],
});

export default ProductBatchProjectionPort;
