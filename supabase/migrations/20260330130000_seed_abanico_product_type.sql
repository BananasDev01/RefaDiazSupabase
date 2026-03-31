INSERT INTO public.product_type (name, active)
SELECT 'ABANICO', true
WHERE NOT EXISTS (
    SELECT 1
    FROM public.product_type
    WHERE lower(name) = 'abanico'
);
