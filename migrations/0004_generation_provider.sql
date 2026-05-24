ALTER TABLE turns ADD COLUMN provider TEXT NOT NULL DEFAULT 'replicate' CHECK (provider IN ('replicate', 'wavespeed'));
ALTER TABLE turns ADD COLUMN delivery_resolution TEXT CHECK (delivery_resolution IN ('480p', '720p', '1080p') OR delivery_resolution IS NULL);
