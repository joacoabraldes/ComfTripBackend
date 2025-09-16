# ComfTrip API Documentation

## Auth Endpoints

### Register
- **POST** `/api/auth/register`
- Body: `{ name, username, email, phone, password, nationality, birthdate }`
- Response: `{ token, user: { id, name, username, email, phone, nationality, birthdate } }`

### Login
- **POST** `/api/auth/login`
- Body: `{ identifier, password }`  
  `identifier` can be either username or email.
- Response: `{ token, user: { id, name, username, email } }`

---

## User Endpoints

### Register (legacy)
- **POST** `/api/users/register`
- Body: `{ name, email, password, nationality, birthdate }`
- Response: `{ message }`

### Get Interests
- **GET** `/api/users/interests`
- Response: `[{ id, slug, title, description }]`

### Save Interests
- **POST** `/api/users/:id/interests`
- Auth required
- Body: `{ interestIds: [1,2,3] }`
- Response: `{ message }`

### Get Profile
- **GET** `/api/users/:id`
- Auth required
- Response: `{ user: { id, name, email, phone, nationality, birthdate }, interests: [{ id, title }] }`

### Edit Profile
- **PUT** `/api/users/:id`
- Auth required
- Body: `{ name, email, phone, nationality, birthdate }`
- Response: `{ message, user }`

### Change Password
- **PUT** `/api/users/:id/password`
- Auth required
- Body: `{ oldPassword, newPassword }`
- Response: `{ message }`

---

## Location Endpoints

### List Locations
- **GET** `/api/locations`
- Query params (optional): `interest`, `limit`, `offset`
- Response: `[{ id, titulo, fk_interest, descripcion, latitude, longitude, imagenes }]`

### Get Location
- **GET** `/api/locations/:id`
- Response: `{ id, titulo, fk_interest, descripcion, latitude, longitude, imagenes }`

### Create Location
- **POST** `/api/locations`
- Auth required
- Body: `{ titulo, fk_interest, descripcion, latitude, longitude, imagenes }`
- Response: `{ message, location }`

### Edit Location
- **PUT** `/api/locations/:id`
- Auth required
- Body: `{ titulo, fk_interest, descripcion, latitude, longitude, imagenes }`
- Response: `{ message, location }`

### Delete Location
- **DELETE** `/api/locations/:id`
- Auth required
- Response: `{ message }`

---

## Trip Endpoints

### Create Trip
- **POST** `/api/trips/`
- Auth required
- Body: `{ destination, start_date, end_date, budget, notes }`
- Response: `{ id }`

### List Trips
- **GET** `/api/trips/`
- Auth required
- Response: `[{ ...trip fields... }]`

### Get Trip
- **GET** `/api/trips/:id`
- Auth required
- Response: `{ ...trip fields... }`

### Edit Trip
- **PUT** `/api/trips/:id`
- Auth required
- Body: `{ destination, start_date, end_date, budget, notes }`
- Response: `{ message }`

### Delete Trip
- **DELETE** `/api/trips/:id`
- Auth required
- Response: `{ message }`

---

## Notes
- All endpoints return errors in `{ message }` or `{ error }` fields.
- Auth endpoints return JWT tokens for authentication.
- Use the token in the `Authorization: Bearer <token>` header for protected endpoints.
