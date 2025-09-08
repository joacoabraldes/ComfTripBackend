# ComfTrip API Documentation

## Auth Endpoints

### Register
- **POST** `/api/auth/register`
- Body: `{ name, email, phone, password, nationality, birthdate }`
- Response: `{ token, user: { id, name, email, phone, nationality, birthdate } }`

### Login
- **POST** `/api/auth/login`
- Body: `{ email, password }`
- Response: `{ token, user: { id, name, email, phone, nationality, birthdate } }`

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
- Response: `{ user: { id, name, email, nationality, birthdate }, interests: [{ id, title }] }`

### Edit Profile
- **PUT** `/api/users/:id`
- Auth required
- Body: `{ name, email, phone, nationality, birthdate }`
- Response: `{ message }`

### Change Password
- **PUT** `/api/users/:id/password`
- Auth required
- Body: `{ oldPassword, newPassword }`
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
