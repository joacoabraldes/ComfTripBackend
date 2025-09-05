-- schema.sql
CREATE DATABASE IF NOT EXISTS comftrip CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE comftrip;

-- Usuarios
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(200) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  nationality VARCHAR(100),
  birthdate DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Intereses predefinidos
CREATE TABLE IF NOT EXISTS interests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(100) NOT NULL UNIQUE,
  title VARCHAR(150) NOT NULL,
  description TEXT
);

-- Relacion usuario - intereses (muchos a muchos)
CREATE TABLE IF NOT EXISTS user_interests (
  user_id INT NOT NULL,
  interest_id INT NOT NULL,
  PRIMARY KEY(user_id, interest_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(interest_id) REFERENCES interests(id) ON DELETE CASCADE
);

-- Viajes
CREATE TABLE IF NOT EXISTS trips (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  destination VARCHAR(200),
  start_date DATE,
  end_date DATE,
  budget DECIMAL(10,2),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Lugares favoritos (opcional: para guardar sitios dentro de un viaje)
CREATE TABLE IF NOT EXISTS favorite_places (
  id INT AUTO_INCREMENT PRIMARY KEY,
  trip_id INT,
  user_id INT,
  name VARCHAR(255),
  description TEXT,
  lat DECIMAL(9,6),
  lng DECIMAL(9,6),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Seed básicos de intereses
INSERT INTO interests (slug, title, description) VALUES
('senderismo', 'Senderismo / Trekking', 'Parques, miradores, senderos'),
('cultura','Cultura y entretenimiento','Museos, arte, exposiciones'),
('gastronomia','Gastronomía','Restaurantes, street food, bodegas'),
('playa','Playas y ríos','Playa, ríos, lagos'),
('aventura','Aventura','Deportes extremos, rafting'),
('relax','Relax y spa','Descanso y bienestar')
ON DUPLICATE KEY UPDATE title=VALUES(title);
