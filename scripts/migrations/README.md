# Migraciones MongoDB

Las migraciones se gestionan con **migrate-mongo** y viven en esta carpeta. El flujo recomendado es:

1. Crear una migración nueva:
   ```bash
   npm run migrate:create -- <nombre>
   ```
2. Editar el archivo generado (ESM) exportando `up` y `down`.
3. Ejecutar las migraciones pendientes:
   ```bash
   npm run migrate:up
   ```
4. (Opcional) Revertir la última migración:
   ```bash
   npm run migrate:down
   ```

> Nota: asegúrate de definir `MONGODB_URI` antes de ejecutar los comandos.
