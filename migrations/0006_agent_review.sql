-- Claude's post-upload review of the pages found in a drawing (which are the basic floor plans, names, reasons).
ALTER TABLE cad_files ADD COLUMN agent_review TEXT;
