ALTER TABLE turns ADD COLUMN resolution TEXT CHECK (resolution IN ('1k', '2k') OR resolution IS NULL);
