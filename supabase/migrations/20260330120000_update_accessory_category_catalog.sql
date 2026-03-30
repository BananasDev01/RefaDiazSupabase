WITH accessory_type AS (
    SELECT id
    FROM public.product_type
    WHERE lower(name) = 'accesorio'
    LIMIT 1
)
UPDATE public.product_category pc
SET
    description = mapped.description,
    order_id = mapped.order_id,
    active = TRUE
FROM accessory_type at
JOIN (
    VALUES
        ('mangueras', 'Categoria para accesorios tipo manguera', 1),
        ('tubos', 'Categoria para accesorios tipo tubo', 2),
        ('bases', 'Categoria para accesorios tipo base', 3),
        ('termostatos', 'Categoria para accesorios tipo termostato', 4),
        ('bulbos', 'Categoria para accesorios tipo bulbo', 5),
        ('varios', 'Categoria para accesorios varios', 6)
) AS mapped(name_lower, description, order_id) ON TRUE
WHERE pc.product_type_id = at.id
  AND lower(pc.name) = mapped.name_lower;

WITH accessory_type AS (
    SELECT id
    FROM public.product_type
    WHERE lower(name) = 'accesorio'
    LIMIT 1
),
existing_varios AS (
    SELECT pc.id
    FROM public.product_category pc
    JOIN accessory_type at ON at.id = pc.product_type_id
    WHERE lower(pc.name) = 'varios'
    LIMIT 1
),
legacy_otros AS (
    SELECT pc.id
    FROM public.product_category pc
    JOIN accessory_type at ON at.id = pc.product_type_id
    WHERE lower(pc.name) = 'otros'
    LIMIT 1
)
UPDATE public.product p
SET product_category_id = ev.id
FROM existing_varios ev
JOIN legacy_otros lo ON TRUE
WHERE p.product_category_id = lo.id;

WITH accessory_type AS (
    SELECT id
    FROM public.product_type
    WHERE lower(name) = 'accesorio'
    LIMIT 1
)
UPDATE public.product_category pc
SET active = FALSE
FROM accessory_type at
WHERE pc.product_type_id = at.id
  AND lower(pc.name) = 'otros'
  AND EXISTS (
      SELECT 1
      FROM public.product_category existing_pc
      WHERE existing_pc.product_type_id = at.id
        AND lower(existing_pc.name) = 'varios'
  );

WITH accessory_type AS (
    SELECT id
    FROM public.product_type
    WHERE lower(name) = 'accesorio'
    LIMIT 1
)
UPDATE public.product_category pc
SET
    name = 'Varios',
    description = 'Categoria para accesorios varios',
    order_id = 6,
    active = TRUE
FROM accessory_type at
WHERE pc.product_type_id = at.id
  AND lower(pc.name) = 'otros'
  AND NOT EXISTS (
      SELECT 1
      FROM public.product_category existing_pc
      WHERE existing_pc.product_type_id = at.id
        AND lower(existing_pc.name) = 'varios'
  );

WITH accessory_type AS (
    SELECT id
    FROM public.product_type
    WHERE lower(name) = 'accesorio'
    LIMIT 1
),
target_categories(name, description, order_id) AS (
    VALUES
        ('Mangueras', 'Categoria para accesorios tipo manguera', 1),
        ('Tubos', 'Categoria para accesorios tipo tubo', 2),
        ('Bases', 'Categoria para accesorios tipo base', 3),
        ('Termostatos', 'Categoria para accesorios tipo termostato', 4),
        ('Bulbos', 'Categoria para accesorios tipo bulbo', 5),
        ('Varios', 'Categoria para accesorios varios', 6)
)
INSERT INTO public.product_category (name, description, product_type_id, order_id, active)
SELECT
    tc.name,
    tc.description,
    at.id,
    tc.order_id,
    TRUE
FROM target_categories tc
CROSS JOIN accessory_type at
WHERE NOT EXISTS (
    SELECT 1
    FROM public.product_category pc
    WHERE pc.product_type_id = at.id
      AND lower(pc.name) = lower(tc.name)
);

WITH accessory_type AS (
    SELECT id
    FROM public.product_type
    WHERE lower(name) = 'accesorio'
    LIMIT 1
)
UPDATE public.product_category pc
SET active = FALSE
FROM accessory_type at
WHERE pc.product_type_id = at.id
  AND lower(pc.name) NOT IN (
      'mangueras',
      'tubos',
      'bases',
      'termostatos',
      'bulbos',
      'varios'
  );
