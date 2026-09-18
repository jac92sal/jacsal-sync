-- Verified address parts filled by geocoding (Settings → address verification).
ALTER TABLE projects ADD COLUMN state TEXT;
ALTER TABLE projects ADD COLUMN zip TEXT;
ALTER TABLE projects ADD COLUMN matched_address TEXT;
ALTER TABLE projects ADD COLUMN geocode_source TEXT;
