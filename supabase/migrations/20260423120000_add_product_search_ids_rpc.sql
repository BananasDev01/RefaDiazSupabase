CREATE OR REPLACE VIEW public.product_effective_compatibility_v1 AS
SELECT
  pcm.product_id,
  pcm.car_model_id,
  cm.brand_id,
  pcm.initial_year,
  pcm.last_year,
  'direct'::text AS compatibility_source
FROM public.product_car_model pcm
JOIN public.car_model cm ON cm.id = pcm.car_model_id
WHERE pcm.active = TRUE

UNION

SELECT
  pc.component_product_id AS product_id,
  pcm.car_model_id,
  cm.brand_id,
  pcm.initial_year,
  pcm.last_year,
  'transitive'::text AS compatibility_source
FROM public.product_component pc
JOIN public.product parent_product
  ON parent_product.id = pc.product_id
  AND parent_product.active = TRUE
JOIN public.product_car_model pcm
  ON pcm.product_id = pc.product_id
  AND pcm.active = TRUE
JOIN public.car_model cm ON cm.id = pcm.car_model_id
WHERE pc.active = TRUE;

CREATE OR REPLACE FUNCTION public.search_product_ids_v1(
  p_product_type_id integer,
  p_name text DEFAULT NULL,
  p_product_category_id integer DEFAULT NULL,
  p_brand_id integer DEFAULT NULL,
  p_model_id integer DEFAULT NULL,
  p_model_ids integer[] DEFAULT NULL,
  p_model_year integer DEFAULT NULL,
  p_include_transitive_compatibility boolean DEFAULT FALSE,
  p_limit integer DEFAULT NULL,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(product_id integer, total_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidate_products AS (
    SELECT
      p.id,
      p.created_at
    FROM public.product p
    WHERE p.active = TRUE
      AND p.product_type_id = p_product_type_id
      AND (
        p_name IS NULL
        OR p_name = ''
        OR p.name ILIKE ('%' || p_name || '%')
      )
      AND (
        p_product_category_id IS NULL
        OR p.product_category_id = p_product_category_id
      )
      AND (
        (
          p_brand_id IS NULL
          AND p_model_id IS NULL
          AND COALESCE(cardinality(p_model_ids), 0) = 0
          AND p_model_year IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM public.product_effective_compatibility_v1 pec
          WHERE pec.product_id = p.id
            AND (
              p_include_transitive_compatibility = TRUE
              OR pec.compatibility_source = 'direct'
            )
            AND (
              p_brand_id IS NULL
              OR pec.brand_id = p_brand_id
            )
            AND (
              p_model_id IS NULL
              OR pec.car_model_id = p_model_id
            )
            AND (
              COALESCE(cardinality(p_model_ids), 0) = 0
              OR pec.car_model_id = ANY(p_model_ids)
            )
            AND (
              p_model_year IS NULL
              OR (
                (pec.initial_year IS NULL OR pec.initial_year <= p_model_year)
                AND (pec.last_year IS NULL OR pec.last_year >= p_model_year)
              )
            )
        )
      )
  )
  SELECT
    candidate_products.id AS product_id,
    count(*) OVER() AS total_count
  FROM candidate_products
  ORDER BY candidate_products.created_at DESC, candidate_products.id DESC
  LIMIT CASE
    WHEN p_limit IS NULL THEN NULL
    ELSE GREATEST(p_limit, 0)
  END
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

GRANT SELECT ON public.product_effective_compatibility_v1
  TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.search_product_ids_v1(
  integer,
  text,
  integer,
  integer,
  integer,
  integer[],
  integer,
  boolean,
  integer,
  integer
) TO anon, authenticated, service_role;
