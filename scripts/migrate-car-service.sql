CREATE TABLE IF NOT EXISTS car_service_visits (
  id serial PRIMARY KEY,
  date text NOT NULL,
  odometer_km integer NOT NULL,
  notes text,
  created_at timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS car_service_items (
  id serial PRIMARY KEY,
  visit_id integer NOT NULL REFERENCES car_service_visits (id) ON DELETE CASCADE,
  category text DEFAULT 'Material' NOT NULL,
  description text NOT NULL,
  amount numeric(12, 2) NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS car_service_items_visit_id_idx ON car_service_items (visit_id);
CREATE INDEX IF NOT EXISTS car_service_visits_date_idx ON car_service_visits (date);
