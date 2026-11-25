ALTER TABLE car_service_visits
    ADD COLUMN IF NOT EXISTS visit_type TEXT NOT NULL DEFAULT 'Normal service' CHECK (visit_type IN ('Normal service', 'Accessory repair'));
