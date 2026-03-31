# Feature UI: Seccion De Abanicos En Radiadores

## Objetivo

Agregar en la UI una seccion de `Abanicos` dentro del flujo de `Radiadores`, con el mismo comportamiento visual y funcional que hoy tiene la seccion de `Tapas`.

`Abanico` se manejará como un componente de radiador usando el backend actual de `components`.

## Alcance

La UI debe permitir que un radiador:

- vea los abanicos asociados
- agregue abanicos existentes
- cree un abanico nuevo
- quite abanicos asociados

Esta seccion debe comportarse igual que `Tapas`, pero usando productos de tipo `ABANICO`.

## Modelo Funcional

`Abanico` no tiene tabla propia.

Se maneja igual que `Tapa`:

- es un registro normal en `product`
- se asocia al radiador por medio de `components`
- viaja dentro del mismo arreglo `components` del radiador

La UI debe separar visualmente los componentes en dos grupos:

- `Tapas`
- `Abanicos`

La separación se hace usando `componentProduct.productTypeId`.

## Campos Del Abanico

Por ahora, el formulario de abanico solo debe manejar:

- `name`
- `comments`
- `dpi` como clave
- `files` como fotos
- `productProviders`

No agregar otros campos en esta primera entrega.

## Comportamiento Esperado En UI

En alta y edición de radiador:

- agregar una nueva seccion llamada `Abanicos`
- reutilizar el mismo patrón visual y de interacción que existe para `Tapas`
- permitir buscar o seleccionar abanicos existentes
- permitir crear un abanico nuevo desde esa misma experiencia
- permitir remover abanicos de la asociación actual del radiador

Si ya existe un modal, drawer o subformulario para `Tapas`, reutilizar la misma estructura para `Abanicos`.

## Contrato Con Backend

### Crear abanico

Endpoint:

- `POST /products`

Payload base:

```json
{
  "name": "ABANICO X",
  "comments": "Comentario",
  "dpi": "CLAVE-123",
  "productTypeId": 4,
  "files": [
    {
      "name": "abanico.png",
      "mimeType": "image/png",
      "storagePath": "products/images/abanico.png",
      "orderId": 1
    }
  ],
  "productProviders": [
    {
      "providerId": 2,
      "numSeries": "SERIE-001",
      "price": {
        "description": "Costo abanico",
        "cost": "$500.00"
      }
    }
  ]
}
```

Notas:

- `productTypeId` de `ABANICO` en el Postman actual está configurado como `4`
- `dpi` es la clave
- `files` son las fotos

### Obtener radiador con sus componentes

Endpoint:

- `GET /products?id=<radiatorId>`

La respuesta ya incluye:

- `components`

Cada elemento incluye:

- `componentProductId`
- `componentProduct`
- `componentProduct.productTypeId`

La UI debe usar ese `productTypeId` para separar `Tapas` de `Abanicos`.

### Guardar radiador con tapas y abanicos

Endpoint:

- `POST /products`
- `PUT /products?id=<radiatorId>`

El backend sigue esperando un solo arreglo `components`.

Ejemplo:

```json
{
  "components": [
    { "componentProductId": 101 },
    { "componentProductId": 202 }
  ]
}
```

La UI debe combinar en ese arreglo final:

- ids de tapas seleccionadas
- ids de abanicos seleccionados

## Reglas De Implementacion Para Frontend

- tratar `Tapas` y `Abanicos` como vistas separadas de la misma estructura `components`
- filtrar por `productTypeId` para pintar cada bloque
- al crear un abanico nuevo, enviar `productTypeId = 4`
- al guardar el radiador, reconstruir `components` con ambos tipos
- no depender de validaciones backend nuevas en esta entrega

## Criterios De Aceptacion

- un radiador muestra una seccion independiente de `Abanicos`
- la UI muestra solo abanicos dentro de esa seccion
- se puede crear un abanico desde la UI
- se puede asociar un abanico existente al radiador
- se puede quitar un abanico de la asociación
- al reabrir el radiador, la UI separa correctamente `Tapas` y `Abanicos`
- la UI sigue enviando un solo arreglo `components` al guardar el radiador

## Fuera De Alcance

- validaciones estrictas de negocio en backend
- restricciones backend para impedir tipos incorrectos en `components`
- búsqueda especializada de abanicos fuera del flujo de radiadores

## Nota Importante

Para esta entrega, `Abanicos` debe implementarse como un clon funcional de `Tapas`, cambiando únicamente:

- el nombre de la seccion
- el filtro por tipo de producto
- el `productTypeId` al crear el producto
