-- One row per photo form submission (its server-issued request id), so a resubmitted form is not read or billed twice.
CREATE TABLE IF NOT EXISTS photo_requests (id TEXT PRIMARY KEY, day TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS photo_requests_day ON photo_requests (day);
