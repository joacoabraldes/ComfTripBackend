-- schema_postgres.sql
CREATE SCHEMA IF NOT EXISTS public;

-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(200) NOT NULL UNIQUE,
  phone VARCHAR(30),
  password_hash VARCHAR(255) NOT NULL,
  nationality VARCHAR(100),
  birthdate DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Interests
CREATE TABLE IF NOT EXISTS interests (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(100) NOT NULL UNIQUE,
  title VARCHAR(150) NOT NULL,
  description TEXT
);

-- user_interests (many-to-many)
CREATE TABLE IF NOT EXISTS user_interests (
  user_id INT NOT NULL,
  interest_id INT NOT NULL,
  PRIMARY KEY(user_id, interest_id),
  CONSTRAINT fk_ui_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ui_interest FOREIGN KEY(interest_id) REFERENCES interests(id) ON DELETE CASCADE
);

-- Trips
CREATE TABLE IF NOT EXISTS trips (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  destination VARCHAR(200),
  start_date DATE,
  end_date DATE,
  budget NUMERIC(10,2),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT fk_trips_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Favorite places
CREATE TABLE IF NOT EXISTS favorite_places (
  id SERIAL PRIMARY KEY,
  trip_id INT,
  user_id INT,
  name VARCHAR(255),
  description TEXT,
  lat NUMERIC(9,6),
  lng NUMERIC(9,6),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT fk_fp_trip FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE CASCADE,
  CONSTRAINT fk_fp_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Seed interests
INSERT INTO interests (slug, title, description) VALUES
('senderismo', 'Senderismo / Trekking', 'Parques, miradores, senderos'),
('cultura','Cultura y entretenimiento','Museos, arte, exposiciones'),
('gastronomia','Gastronomía','Restaurantes, street food, bodegas'),
('playa','Playas y ríos','Playa, ríos, lagos'),
('aventura','Aventura','Deportes extremos, rafting'),
('relax','Relax y spa','Descanso y bienestar')
ON CONFLICT(slug) DO UPDATE SET title = EXCLUDED.title;
