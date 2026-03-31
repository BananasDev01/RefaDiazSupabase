# Postman collection

Import [refadiaz-supabase.postman_collection.json](/Users/eduardomendoza/Projects/RefaDiazSystem/RefaDiazSupabase/supabase/postman/refadiaz-supabase.postman_collection.json) into Postman.

The collection is configured for local Supabase by default:

- `baseUrl`: `http://127.0.0.1:54321/functions/v1`
- `accessToken`: local anon JWT used by `supabase start`

Recommended execution order:

1. `01 Seed Reads`
2. `02 Brands Flow`
3. `03 Models Flow`
4. `04 Providers Flow`
5. `05 Persons Flow`
6. `06 Users Flow`
7. `07 Products Flow`
8. `08 Files Flow`

Notes:

- Create requests save generated IDs into collection variables, so the following `GET -> PUT -> DELETE` requests can be executed without manual edits.
- The collection covers the edge functions that currently exist in `functions/`.
- `login` / `logout` are mentioned in [functions/README.md](/Users/eduardomendoza/Projects/RefaDiazSystem/RefaDiazSupabase/supabase/functions/README.md) but there are no function folders for them in this workspace.
- Product components are currently covered in the collection under `07 Products Flow > Components Example Flow`, including `TAPA`, `ABANICO`, and radiator association examples.
- The collection assumes `TAPA` resolves to `productTypeId = 2` and `ABANICO` resolves to `productTypeId = 4`. If your database differs, update `productTypeIdTapa` and `productTypeIdAbanico` before running that flow.
