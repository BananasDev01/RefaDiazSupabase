# Vehicle Notes API Contract

## Purpose

`vehicle-notes` is a knowledge entity for vehicle-specific notes, installation guidance, diagnostics, and repair recommendations.

This entity is independent from `product`. A note may be associated with zero or one `car_model`.

## Base Endpoint

Use the Supabase Edge Function route:

```text
/functions/v1/vehicle-notes
```

Examples:

```text
GET    /functions/v1/vehicle-notes
GET    /functions/v1/vehicle-notes?id=123
POST   /functions/v1/vehicle-notes
PUT    /functions/v1/vehicle-notes?id=123
DELETE /functions/v1/vehicle-notes?id=123
```

## Auth And Content Type

- Send the same bearer token strategy already used for the other edge functions.
- For `POST` and `PUT`, send `Content-Type: application/json`.

## Markdown Contract

The API stores the note body as raw Markdown in `contentMarkdown`.

Frontend must treat `contentMarkdown` as the source of rich text rendering:

- Do not display the raw Markdown string directly in the final reading view.
- Render it as formatted content on the client side.
- Prefer safe Markdown rendering with HTML sanitization if the renderer allows embedded HTML.
- Keep the editing experience in Markdown as well, since the backend persists Markdown, not HTML.

Example stored value:

```md
# Procedimiento de purga

- Revisar abanico
- No abrir en caliente
- Confirmar nivel final
```

## Entity Shape

### VehicleNote

```json
{
  "id": 123,
  "title": "Procedimiento de purga",
  "contentMarkdown": "# Procedimiento de purga\n\n- Revisar abanico",
  "carModelId": 6,
  "carModel": {
    "id": 6,
    "name": "F150",
    "brand": {
      "id": 16,
      "name": "Ford"
    }
  },
  "files": [
    {
      "id": 90,
      "name": "purga-1.png",
      "mimeType": "image/png",
      "storagePath": "vehicle-notes/purga-1.png",
      "objectId": 123,
      "orderId": 1,
      "fileType": {
        "id": 3,
        "name": "Vehicle Note Image"
      },
      "active": true,
      "createdAt": "2026-03-10T10:00:00",
      "updatedAt": "2026-03-10T10:00:00"
    }
  ],
  "active": true,
  "createdAt": "2026-03-10T10:00:00",
  "updatedAt": "2026-03-10T10:00:00"
}
```

### File Input

```json
{
  "id": 90,
  "name": "purga-1.png",
  "mimeType": "image/png",
  "storagePath": "vehicle-notes/purga-1.png",
  "orderId": 1,
  "active": true
}
```

## Endpoints

### GET /vehicle-notes

Returns active notes ordered by `createdAt desc`.

Supported query params:

- `id`
  - Reserved for detail mode. Use `GET /vehicle-notes?id=123`.
- `q`
  - Text search over:
    - note `title`
    - `carModel.name`
    - `carModel.brand.name`
- `carModelId`
  - Exact filter by model.
- `brandId`
  - Exact filter by brand through the related model.

Examples:

```text
GET /vehicle-notes
GET /vehicle-notes?q=purga
GET /vehicle-notes?q=Ford
GET /vehicle-notes?carModelId=6
GET /vehicle-notes?brandId=16
GET /vehicle-notes?carModelId=6&brandId=16
```

Response:

- `200 OK`
- Array of `VehicleNote`

### GET /vehicle-notes?id=<id>

Returns a single active note with:

- note fields
- `carModel`
- nested `brand`
- ordered `files`

Responses:

- `200 OK`
- `404` if the note does not exist or is inactive

### POST /vehicle-notes

Creates a new note.

Request body:

```json
{
  "title": "Procedimiento de purga",
  "contentMarkdown": "# Procedimiento de purga\n\n- Revisar abanico",
  "carModelId": 6,
  "files": [
    {
      "name": "purga-1.png",
      "mimeType": "image/png",
      "storagePath": "vehicle-notes/purga-1.png",
      "orderId": 1
    },
    {
      "name": "purga-2.png",
      "mimeType": "image/png",
      "storagePath": "vehicle-notes/purga-2.png",
      "orderId": 2
    }
  ],
  "active": true
}
```

Rules:

- `title` is required.
- `contentMarkdown` is required.
- `carModelId` is optional and may be `null`.
- `files` is optional.

Response:

- `201 Created`
- Returns the created `VehicleNote`

### PUT /vehicle-notes?id=<id>

Updates an existing note.

Supported fields:

- `title`
- `contentMarkdown`
- `carModelId`
- `active`
- `files`

Example:

```json
{
  "title": "Procedimiento actualizado",
  "contentMarkdown": "# Procedimiento actualizado\n\n- Revisar fugas",
  "carModelId": 6,
  "files": [
    {
      "id": 90,
      "name": "purga-1-actualizada.png",
      "mimeType": "image/png",
      "storagePath": "vehicle-notes/purga-1-actualizada.png",
      "orderId": 1
    }
  ]
}
```

File synchronization behavior:

- If `files` is omitted, the backend leaves existing images unchanged.
- If `files` is present, the backend treats it as full replacement for the note image set.
- Existing file objects sent with `id` are updated.
- New file objects without `id` are created.
- Existing note images not included in the `files` array are removed.

Response:

- `200 OK`
- Returns the updated `VehicleNote`

### DELETE /vehicle-notes?id=<id>

This is a soft delete.

Behavior:

- The backend sets `active = false`.
- The note no longer appears in normal list queries.
- Related image metadata remains associated historically.

Response:

- `200 OK`
- Returns the note payload after deactivation

## Frontend Upload Flow For Images

The API does not upload binary files by itself. It only stores file metadata in `file`.

Expected frontend flow:

1. Upload the image file to the Supabase Storage bucket `vehicle-notes`.
2. Get or build the final storage path.
3. Send that path inside `files[].storagePath` when calling `POST /vehicle-notes` or `PUT /vehicle-notes`.

Example storage path:

```text
vehicle-notes/purga-1.png
```

## UI Recommendations For Frontend

- List view:
  - show `title`
  - show `brand` and `carModel` if present
  - optionally show first image as cover
- Detail view:
  - render `contentMarkdown` as formatted rich text
  - render `files` in `orderId` order
- Edit view:
  - Markdown editor or textarea for `contentMarkdown`
  - image uploader that produces `storagePath`
  - ordered image list so the user can control process steps visually

## Error Expectations

Common cases:

- `400`
  - missing required params
  - invalid JSON
  - invalid file synchronization payload
- `404`
  - note not found for detail or update target not found
- `500`
  - database/storage metadata persistence error

## Current Scope

Current backend scope intentionally does not include:

- multiple models per note
- tags
- categories
- HTML body persistence
- body full-text search
