DROP POLICY IF EXISTS "Public read access on vehicle-notes" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated write access on vehicle-notes" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated update access on vehicle-notes" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated delete access on vehicle-notes" ON storage.objects;

CREATE POLICY "Public read access on vehicle-notes" ON storage.objects
    FOR SELECT
    TO anon, authenticated
    USING (bucket_id = 'vehicle-notes');

CREATE POLICY "Authenticated write access on vehicle-notes" ON storage.objects
    FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'vehicle-notes');

CREATE POLICY "Authenticated update access on vehicle-notes" ON storage.objects
    FOR UPDATE
    TO authenticated
    USING (bucket_id = 'vehicle-notes');

CREATE POLICY "Authenticated delete access on vehicle-notes" ON storage.objects
    FOR DELETE
    TO authenticated
    USING (bucket_id = 'vehicle-notes');
