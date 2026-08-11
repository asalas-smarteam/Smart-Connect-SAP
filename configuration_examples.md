
Detalle: 
Cuando un cliente quiere que sus errores se muestren en hubspot y si requiere que se retorne a otra etapa 
{ key: 'requireMessageHS', value: { requireMessageHS: false, requiereReturnStage: false, stageToReturned: null } }

Detalle:
Cuando un cliente quiere que, al procesar un webhook de deal (order/quotation/inventoryTransfer) y el BusinessPartner/ContactEmployee ya exista en SAP, se actualice con la data actual de HubSpot en vez de solo tomar el CardCode. fieldsUpdated_BP/fieldsUpdated_CE son nombres de campo SAP (no de HubSpot); cada uno puede ir null/[] para dejar esa entidad sin actualizar. Solo se envía el PATCH si algún campo difiere entre HubSpot y SAP.
{ key: 'upsertDataSAP', value: { required: true, fieldsUpdated_BP: ['EmailAddress', 'CardName'], fieldsUpdated_CE: ['Name', 'E_Mail'] } }