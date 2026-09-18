-- Autodesk Model Derivative translation of each drawing for the APS Viewer (AutoCAD's own rendering in the browser).
ALTER TABLE cad_files ADD COLUMN viewer_urn TEXT;
ALTER TABLE cad_files ADD COLUMN viewer_status TEXT;
