# Changelog

## 2026-03-30

### Abanico As Product Component

Added `ABANICO` as a supported `product_type` so radiator components can now be represented with the same generic `product` + `product_component` model already used by `TAPA`.

High-level changes:
- Seeded `ABANICO` in `product_type` through a dedicated migration.
- Extended the Postman component flow with an `ABANICO` example product.
- Updated the radiator component example to reference both `TAPA` and `ABANICO`.

## 2026-03-08

### Vehicle Notes

Implemented a dedicated `vehicle_note` knowledge entity for vehicle installation and repair notes, separate from `product`.

High-level changes:
- Added the `vehicle_note` table with optional association to `car_model`.
- Added `Vehicle Note Image` to `file_type` and reused `file` for ordered note images.
- Added storage policies for the `vehicle-notes` bucket.
- Added the `vehicle-notes` edge function with list, detail, create, update, and soft-delete behavior.
- Implemented Markdown body storage through `contentMarkdown`.
- Enriched note responses with `carModel`, `brand`, and ordered `files`.
- Added list search by note title, car model name, and brand name.
- Added Postman examples for create, list, search, update, and delete flows.

Implementation notes:
- Each note can point to zero or one `car_model` in this iteration.
- Note deletion is logical through `active = false`.
- The storage bucket itself must exist in the environment as `vehicle-notes`; this change only adds the access policies.

### Accessories And Product Categories

Implemented accessory support on top of `product`, including category management, accessory-specific search behavior, and compatibility with vehicle models without year ranges.

High-level changes:
- Added `product_category` and linked it to `product` through `product_category_id`.
- Ensured `RADIATOR`, `TAPA`, and `ACCESORIO` are seeded in `product_type` through migrations.
- Seeded default accessory categories: `Tubos`, `Mangueras`, and `Otros`.
- Added the `product-categories` edge function with list, create, update, and soft-delete behavior.
- Extended `GET /products` and `GET /products?id=...` to return `productCategory`.
- Extended `POST /products` and `PUT /products?id=...` to accept `productCategoryId`.
- Kept accessory payloads minimal for prices/providers/components while allowing `productCarModels`.
- Enabled accessory-to-model associations without requiring `initialYear` or `lastYear`.
- Added accessory smart search separated from radiator smart search.
- Kept `q` as an exclusive search mode and made accessory search token-based for:
  - product name tokens
  - model tokens
  - brand tokens
- Added Postman examples for:
  - accessory with model association
  - accessory without model association
  - accessory category CRUD

Implementation notes:
- Accessory compatibility is stored in `product_car_model`.
- For accessories, `initial_year` and `last_year` are persisted as `NULL`.
- Accessory smart search is intentionally separate from the radiator search service to avoid mixing DPI/year logic with accessory name/model/brand semantics.

## 2026-03-06

### Product Components For Radiators

Implemented reusable product components for radiators, with `TAPA` as the first supported component type.

High-level changes:
- Added the `product_component` bridge table with logical deletion support through inherited `control_fields`.
- Ensured `TAPA` exists in `product_type`.
- Extended `GET /products?id=...` to return active `components`.
- Extended `POST /products` to accept `components` and create product-component associations.
- Extended `PUT /products?id=...` to synchronize `components` with full replacement semantics.
- Implemented logical removal and reactivation of component relationships in `product_component`.
- Added Postman create/update flows for components inside `07 Products Flow > Components Example Flow`.

Implementation notes:
- A component remains a normal row in `product`.
- Vehicle compatibility stays on the parent radiator through `product_car_model`.
- Component compatibility is transitive from the parent radiator.
- In this iteration, components must be created first and then referenced by `componentProductId` in the radiator payload.
