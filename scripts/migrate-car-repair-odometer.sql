ALTER TABLE car_service_visits
    ALTER COLUMN odometer_km DROP NOT NULL,
    DROP CONSTRAINT IF EXISTS car_service_requires_odometer,
    ADD CONSTRAINT car_service_requires_odometer CHECK (visit_type = 'Accessory repair' OR odometer_km IS NOT NULL);
