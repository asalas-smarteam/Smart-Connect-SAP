import { createPort } from '../port-validator.js';

// Imágenes de los tickets, en la base del tenant.
//   put(tenantKey, { ticketId, filename, contentType, data })  → { fileId, filename, contentType, size }
//   open(tenantKey, { ticketId, fileId })  → { stream, contentType, size } o null si no es de ese ticket
//   remove(tenantKey, fileIds)             → nunca lanza (limpieza best effort)
export const TicketAttachmentStorePort = createPort({
  name: 'TicketAttachmentStorePort',
  methods: [
    'put',
    'open',
    'remove',
  ],
});
