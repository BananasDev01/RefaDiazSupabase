# Uso del contrato OpenAPI

El contrato fuente de las Edge Functions operativas está en
[`openapi.yaml`](./openapi.yaml). Incluye clientes, vehículos, servicios,
cotizaciones y conversión de una opción aceptada a servicio. Supabase Auth no
se redefine: el cliente obtiene el JWT mediante el SDK oficial y lo usa en este
contrato.

## Autenticación

Las llamadas HTTP directas requieren los dos encabezados:

```http
apikey: <SUPABASE_ANON_KEY>
Authorization: Bearer <ACCESS_TOKEN>
```

`supabase.functions.invoke(...)` agrega la configuración del proyecto y la
sesión vigente automáticamente. El usuario autenticado también debe existir y
estar activo en las tablas de aplicación con rol `ADMINISTRADOR` o `EMPLEADO`.

## Abrirlo visualmente

El archivo puede importarse directamente en Swagger Editor, Swagger UI,
Postman o Insomnia. Para una previsualización local sin incorporar archivos de
UI al backend:

```bash
npx @redocly/cli preview-docs supabase/docs/openapi.yaml
```

Desde el directorio `supabase/`, la ruta es simplemente
`docs/openapi.yaml`.

## Generar tipos TypeScript

En el proyecto frontend se pueden generar tipos sin duplicar interfaces:

```bash
npx openapi-typescript /ruta/al/backend/supabase/docs/openapi.yaml \
  --output src/api/refadiaz-api.d.ts
```

El frontend debe seguir generando los UUID de `externalId`. Los campos
`lineTotal`, `subtotal` y `total` de cotizaciones son de solo lectura: puede
mostrarlos como previsualización, pero la respuesta del servidor es la fuente
autoritativa.

## Validación

Después de modificar rutas, payloads o respuestas se debe ejecutar:

```bash
npx @redocly/cli lint docs/openapi.yaml
```

Los documentos Markdown de decisiones explican reglas de negocio; OpenAPI es
la fuente de verdad del contrato HTTP consumido por frontend.
