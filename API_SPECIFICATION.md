# Putting Test Suite API Specification

## Protocol: ORPC over HTTP

This API uses the ORPC (Object RPC) protocol as defined at https://orpc.unnoq.com/docs/advanced/rpc-protocol

### Base URL
```
https://api.putting-test-suite.com/rpc
```

### Request Format
All requests follow ORPC format with payload wrapped in `json` field:
```json
{
  "json": { /* actual payload */ },
  "meta": [/* metadata array */]
}
```

### Response Format
All responses follow ORPC format:
```json
{
  "json": { /* response data */ },
  "meta": [/* metadata array with type information */]
}
```

### Authentication
- JWT Bearer tokens in `Authorization` header
- Token format: `Authorization: Bearer <jwt_token>`

---

## Endpoints

### 1. Authentication

#### Register User
**Endpoint:** `POST /rpc/auth/register`

**Request:**
```json
{
  "json": {
    "email": "user@example.com",
    "password": "securePassword123",
    "firstName": "John",
    "lastName": "Doe"
  },
  "meta": []
}
```

**Response (201 Created):**
```json
{
  "json": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "uuid-string",
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "createdAt": "2025-07-12T14:30:00.000Z"
    }
  },
  "meta": [[1, "createdAt"]]
}
```

#### Login User
**Endpoint:** `POST /rpc/auth/login`

**Request:**
```json
{
  "json": {
    "email": "user@example.com",
    "password": "securePassword123"
  },
  "meta": []
}
```

**Response (200 OK):**
```json
{
  "json": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "uuid-string",
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "lastLoginAt": "2025-07-12T14:30:00.000Z"
    }
  },
  "meta": [[1, "lastLoginAt"]]
}
```

### 2. Test Catalog

#### Get Available Tests
**Endpoint:** `GET /rpc/tests/list`

**Headers:** `Authorization: Bearer <token>`

**Response (200 OK):**
```json
{
  "json": {
    "tests": [
      {
        "testId": "putting-18",
        "name": "18-Hole Putting Test",
        "description": "Standard 18-hole putting test with varied distances",
        "holeCount": 18,
        "distances": [1.5, 12.0, 0.6, 4.0, 1.2, 16.0, 8.0, 3.0, 6.0, 9.0, 0.9, 7.0, 2.1, 3.5, 10.0, 1.8, 5.0, 2.4]
      },
      {
        "testId": "putting-9",
        "name": "9-Hole Putting Test",
        "description": "Quick 9-hole putting test",
        "holeCount": 9,
        "distances": [1.5, 12.0, 0.6, 4.0, 1.2, 16.0, 8.0, 3.0, 6.0]
      }
    ]
  },
  "meta": []
}
```

### 3. Rounds Management

#### Submit Round
**Endpoint:** `POST /rpc/rounds/create`

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "json": {
    "testId": "putting-18",
    "testName": "18-Hole Putting Test",
    "date": "2025-07-12T14:30:00.000Z",
    "holes": [
      {
        "hole": 1,
        "distance": 1.5,
        "putts": 2
      },
      {
        "hole": 2,
        "distance": 12.0,
        "putts": 3
      }
    ]
  },
  "meta": [[1, "date"]]
}
```

**Response (201 Created):**
```json
{
  "json": {
    "roundId": "uuid-string",
    "userId": "user-uuid",
    "testId": "putting-18",
    "testName": "18-Hole Putting Test",
    "totalPutts": 36,
    "createdAt": "2025-07-12T14:30:00.000Z",
    "completedAt": "2025-07-12T14:45:00.000Z"
  },
  "meta": [[1, "createdAt"], [1, "completedAt"]]
}
```

#### Get User Rounds
**Endpoint:** `GET /rpc/rounds/list`

**Headers:** `Authorization: Bearer <token>`

**Query Parameters:**
- `limit` (optional): Number of rounds to return (default: 50)
- `offset` (optional): Number of rounds to skip (default: 0)
- `from` (optional): Start date filter (ISO 8601)
- `to` (optional): End date filter (ISO 8601)

**Response (200 OK):**
```json
{
  "json": {
    "rounds": [
      {
        "roundId": "uuid-string",
        "testId": "putting-18",
        "testName": "18-Hole Putting Test",
        "date": "2025-07-12T14:30:00.000Z",
        "totalPutts": 36,
        "holesCompleted": 18
      }
    ],
    "pagination": {
      "total": 125,
      "offset": 0,
      "limit": 50,
      "hasMore": true
    }
  },
  "meta": [[1, "date"]]
}
```

#### Get Round Details
**Endpoint:** `GET /rpc/rounds/get`

**Headers:** `Authorization: Bearer <token>`

**Query Parameters:**
- `roundId`: UUID of the round

**Response (200 OK):**
```json
{
  "json": {
    "roundId": "uuid-string",
    "userId": "user-uuid",
    "testId": "putting-18",
    "testName": "18-Hole Putting Test",
    "date": "2025-07-12T14:30:00.000Z",
    "totalPutts": 36,
    "holes": [
      {
        "hole": 1,
        "distance": 1.5,
        "putts": 2
      },
      {
        "hole": 2,
        "distance": 12.0,
        "putts": 3
      }
    ],
    "createdAt": "2025-07-12T14:30:00.000Z",
    "completedAt": "2025-07-12T14:45:00.000Z"
  },
  "meta": [[1, "date"], [1, "createdAt"], [1, "completedAt"]]
}
```

### 4. User Profile

#### Get User Profile
**Endpoint:** `GET /rpc/user/profile`

**Headers:** `Authorization: Bearer <token>`

**Response (200 OK):**
```json
{
  "json": {
    "user": {
      "id": "uuid-string",
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "lastLoginAt": "2025-07-12T14:30:00.000Z"
    },
    "stats": {
      "totalRounds": 25,
      "totalPutts": 900,
      "averagePuttsPerRound": 36.0,
      "bestRound": 32,
      "worstRound": 42
    }
  },
  "meta": [[1, "createdAt"], [1, "lastLoginAt"]]
}
```

---

## Error Responses

All error responses follow ORPC format:

### 400 Bad Request
```json
{
  "json": {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Invalid email format",
      "details": {
        "field": "email",
        "value": "invalid-email"
      }
    }
  },
  "meta": []
}
```

### 401 Unauthorized
```json
{
  "json": {
    "error": {
      "code": "UNAUTHORIZED",
      "message": "Invalid or expired token"
    }
  },
  "meta": []
}
```

### 403 Forbidden
```json
{
  "json": {
    "error": {
      "code": "FORBIDDEN",
      "message": "Access denied to resource"
    }
  },
  "meta": []
}
```

### 404 Not Found
```json
{
  "json": {
    "error": {
      "code": "NOT_FOUND",
      "message": "Round not found"
    }
  },
  "meta": []
}
```

### 422 Unprocessable Entity
```json
{
  "json": {
    "error": {
      "code": "BUSINESS_LOGIC_ERROR",
      "message": "Cannot submit round with incomplete holes",
      "details": {
        "missingHoles": [3, 7, 12]
      }
    }
  },
  "meta": []
}
```

### 500 Internal Server Error
```json
{
  "json": {
    "error": {
      "code": "INTERNAL_ERROR",
      "message": "An unexpected error occurred"
    }
  },
  "meta": []
}
```

---

## Data Types & Validation

### Date Format
- All dates use ISO 8601 format: `YYYY-MM-DDTHH:mm:ss.sssZ`
- Marked in meta array with type `1` for timestamp

### UUIDs
- All IDs are UUID v4 format
- Example: `123e4567-e89b-12d3-a456-426614174000`

### Validation Rules
- **Email**: Must be valid email format
- **Password**: Minimum 8 characters, must contain letters and numbers
- **Putts**: Integer between 1 and 10 per hole
- **Distance**: Float between 0.1 and 50.0 meters
- **Hole Numbers**: Sequential integers starting from 1

---

## Rate Limiting

- **Authentication endpoints**: 5 requests per minute per IP
- **Data endpoints**: 100 requests per minute per user
- **Bulk operations**: 10 requests per minute per user

Rate limit headers included in responses:
- `X-RateLimit-Limit`: Request limit
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Reset timestamp