ALTER TABLE turns ADD COLUMN generation_mode TEXT NOT NULL DEFAULT 'image' CHECK (generation_mode IN ('image', 'video'));
ALTER TABLE turns ADD COLUMN video_resolution TEXT CHECK (video_resolution IN ('480p', '720p') OR video_resolution IS NULL);
ALTER TABLE turns ADD COLUMN video_duration INTEGER;
ALTER TABLE turns ADD COLUMN generate_audio INTEGER CHECK (generate_audio IN (0, 1) OR generate_audio IS NULL);
