-- Model pages found inside a sheet set, and which page each retained entity belongs to.
ALTER TABLE cad_files ADD COLUMN models TEXT;
ALTER TABLE cad_entities ADD COLUMN model_ix INTEGER;
CREATE INDEX idx_entities_model ON cad_entities(file_id, model_ix);
ALTER TABLE cad_files ADD COLUMN insunits INTEGER;
