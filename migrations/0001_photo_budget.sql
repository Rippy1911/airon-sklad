-- One row per UTC day: how many label photos the model has been asked to read. Counted before the call.
CREATE TABLE IF NOT EXISTS photo_budget (
  day TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0
);
