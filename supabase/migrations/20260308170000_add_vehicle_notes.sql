CREATE SEQUENCE IF NOT EXISTS public.vehicle_note_id_seq;

CREATE TABLE IF NOT EXISTS public.vehicle_note (
    id INT NOT NULL DEFAULT nextval('public.vehicle_note_id_seq'::regclass),
    title VARCHAR(300) NOT NULL,
    content_markdown TEXT NOT NULL,
    car_model_id INT,
    CONSTRAINT vehicle_note_pkey PRIMARY KEY (id),
    CONSTRAINT vehicle_note_car_model_id_fkey
        FOREIGN KEY (car_model_id) REFERENCES public.car_model(id) ON DELETE SET NULL
) INHERITS (public.control_fields);

ALTER SEQUENCE public.vehicle_note_id_seq OWNED BY public.vehicle_note.id;

CREATE INDEX IF NOT EXISTS vehicle_note_car_model_id_idx
    ON public.vehicle_note (car_model_id);

INSERT INTO public.file_type (id, name, active)
SELECT 3, 'Vehicle Note Image', true
WHERE NOT EXISTS (
    SELECT 1
    FROM public.file_type
    WHERE id = 3
       OR lower(name) = 'vehicle note image'
);
