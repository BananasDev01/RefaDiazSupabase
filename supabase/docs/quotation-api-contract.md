# Contrato API de cotizaciones

Todas las rutas requieren un usuario activo con rol `ADMINISTRADOR` o
`EMPLEADO`. Las solicitudes y respuestas públicas usan camelCase.

## Agregado

`POST /quotations` crea el encabezado, todas sus opciones y conceptos en una
transacción. `externalId` es el UUID generado por el dispositivo y funciona
como llave de idempotencia. Al sincronizar se asigna el siguiente folio
independiente `COT-*`, comenzando en 5000.

Cada opción requiere un `taxAmount` manual, incluido `0.00`. El cliente no
envía subtotales ni totales autoritativos:

```text
lineTotal = round(quantity * unitPrice, 2)
optionSubtotal = sum(lineTotal)
optionTotal = round(optionSubtotal + taxAmount, 2)
```

Los totales de opciones diferentes nunca se suman entre sí.

Ejemplo abreviado:

```json
{
  "externalId": "uuid",
  "clientVehicleId": 12,
  "quotationDate": "2026-08-20",
  "validUntil": "2026-09-20",
  "options": [
    {
      "externalId": "uuid",
      "name": "Radiador nuevo",
      "taxAmount": 400,
      "warrantyMonths": 6,
      "items": [
        {
          "externalId": "uuid",
          "productId": null,
          "description": "Radiador nuevo",
          "quantity": 1,
          "unitPrice": 2500
        }
      ]
    }
  ]
}
```

## Rutas

- `GET /quotations`: filtros `folio`, `clientId`, `phone`, `status`,
  `dateFrom`, `dateTo`, `limit` y `offset`.
- `GET /quotations/:externalId`: detalle con alternativas y conceptos.
- `PUT /quotations/:externalId`: reemplaza atómicamente las opciones; requiere
  `expectedVersion`.
- `POST /quotations/:externalId/send`: pasa un borrador vigente a `SENT`.
- `POST /quotations/:externalId/cancel`: cancela sin borrar el folio.
- `POST /quotations/:externalId/reactivate`: requiere `expectedVersion` y un
  nuevo `validUntil` no vencido.
- `POST /quotations/:externalId/duplicate`: crea un nuevo borrador, UUID y
  folio conservando los snapshots de conceptos y precios.
- `POST /quotations/:externalId/convert`: acepta una opción y crea un servicio.

Los estados públicos son `DRAFT`, `SENT`, `ACCEPTED`, `EXPIRED` y
`CANCELLED`. `EXPIRED` se deriva cuando una cotización en borrador o enviada
rebasa `validUntil`; la conversión queda bloqueada hasta una reactivación
explícita.

## Conversión

La conversión recibe:

```json
{
  "optionExternalId": "uuid",
  "serviceExternalId": "uuid",
  "serviceProvisionalReference": "PEND-SER-...",
  "serviceDate": "2026-08-20",
  "expectedVersion": 3
}
```

En una sola transacción se bloquea la cotización, se valida vigencia y versión,
se acepta exactamente una opción, se crea el servicio con un folio `SER-*`, se
copian sus conceptos a `service_item` y se vinculan ambos documentos. Una
cotización solo puede originar un servicio. Repetir la misma conversión es
idempotente; intentar convertirla con otro `serviceExternalId` produce un
conflicto HTTP 409.
