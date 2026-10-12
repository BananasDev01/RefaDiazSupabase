# Contrato API de clientes, vehículos y servicios

Este documento describe los contratos iniciales de las Edge Functions `clients`
y `services`. Todos los endpoints requieren un JWT de un usuario activo con rol
`ADMINISTRADOR` o `EMPLEADO`. Las respuestas usan `camelCase`.

## Clientes y vehículos

### Crear o conciliar un cliente

`POST /functions/v1/clients`

```json
{
  "externalId": "0f76c0c1-fd87-4d86-901f-77349068b0ea",
  "clientName": "Ana Pérez",
  "phoneNumber": "81 1234 5678",
  "comments": "Cliente frecuente",
  "vehicles": [
    {
      "externalId": "bd8b83c8-b38e-4b37-9ad9-2b80c46f7767",
      "carModelId": 25,
      "modelYear": 2019,
      "version": "Advance",
      "color": "Gris",
      "plate": "ABC-123",
      "comments": "Vehículo principal"
    }
  ]
}
```

El `externalId` es generado por el dispositivo. Repetir el mismo `externalId`
responde `200` con `idempotentReplay: true`. Si el teléfono normalizado ya
existe, se conserva el nombre y teléfono almacenados y únicamente se concilian
los vehículos nuevos. Una creación responde `201`; una conciliación idempotente
responde `200` con `reconciledByPhone: true`.

### Agregar vehículos a un cliente existente

`POST /functions/v1/clients/{clientId}/vehicles`

El cuerpo puede contener `vehicle` o `vehicles`. La operación completa es
atómica.

### Consultar clientes

- `GET /functions/v1/clients/{clientId}`: detalle con todos sus vehículos.
- `GET /functions/v1/clients?q=Versa%202019`: búsqueda libre por nombre,
  teléfono, marca, modelo, año o placa.
- `GET /functions/v1/clients?phone=8112345678`: teléfono normalizado exacto.
- `GET /functions/v1/clients?carModelId=25&modelYear=2019`: modelo y año real.
- `limit` acepta de 1 a 100 y `offset` comienza en 0.

## Servicios

### Crear

`POST /functions/v1/services`

```json
{
  "externalId": "3c8db8a0-027f-473c-94b8-8f67f7f05821",
  "provisionalReference": "PEND-SER-F8A21C",
  "clientVehicleId": 42,
  "serviceDate": "2026-08-19",
  "workManagerUserId": "auth-user-uuid",
  "reportedFailureSummary": "El automóvil se calienta",
  "authorizedWorkDescription": "Servicio de radiador autorizado",
  "vehicleOperationObservations": "La temperatura sube en tráfico",
  "importantInformation": "Revisar nuevamente en una semana",
  "compressionLeakDetected": false,
  "coolingSystemAirPressureDetected": true,
  "radiatorSerialNumber": "225557",
  "radiatorObstructionLevel": 8,
  "subtotal": 1000,
  "taxAmount": 160,
  "warrantyMonths": 6,
  "reportedFailures": [
    {
      "externalId": "113bbadc-8ee0-4101-b45a-f23847cc4e21",
      "reportedFailureTypeId": 1
    }
  ],
  "internalNotes": [
    {
      "externalId": "1ef1bc88-5440-40dd-893b-d05ef36be369",
      "note": "Nota exclusiva del taller"
    }
  ]
}
```

El IVA es un importe explícito obligatorio. La base calcula
`total = (subtotal o 0) + taxAmount`. Al sincronizar se asigna el folio oficial
`SER-####`. Repetir el mismo `externalId` devuelve el servicio existente sin
duplicarlo.

### Editar y cambiar estado

- `PUT /functions/v1/services/{externalId}`: reemplaza los campos mutables y la
  selección de fallas. Requiere `expectedVersion`, `clientVehicleId` y
  `taxAmount`.
- `POST /functions/v1/services/{externalId}/complete`: requiere
  `{ "expectedVersion": 2 }`.
- `POST /functions/v1/services/{externalId}/cancel`: requiere
  `{ "expectedVersion": 2 }`.

Los servicios `COMPLETED` y `CANCELLED` son terminales. Una versión obsoleta
responde `409` con código `SERVICE_VERSION_CONFLICT`. Repetir la misma
finalización o cancelación es idempotente.

### Consultar servicios

- `GET /functions/v1/services/{id-or-externalId}`: detalle.
- `GET /functions/v1/services?clientId=42`: historial de un cliente.
- El listado acepta `folio`, `dateFrom`, `dateTo`, `phone`, `plate`, `status`,
  `limit` y `offset`.
- `GET /functions/v1/services/failure-types`: catálogo de casillas vigentes.

Las notas de `service_internal_note` no forman parte de ningún contrato de
listado o detalle. La Edge Function también elimina defensivamente cualquier
campo `internalNotes` antes de responder.

## Errores

- `400`: payload o filtros inválidos.
- `401`: JWT ausente o inválido.
- `403`: usuario inactivo o rol no permitido.
- `404`: cliente o servicio inexistente.
- `409`: conflicto de identidad offline o versión optimista.
- `422`: relación cliente–vehículo o transición de estado inválida.
