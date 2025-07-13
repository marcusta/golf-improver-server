# Golf Improver Server API Documentation

## Overview

This API provides endpoints for managing putting test data, user authentication, and round tracking for golf improvement applications.

**Base URL**: `http://localhost:3000` (development)  
**Protocol**: HTTP POST with JSON payloads  
**Authentication**: Bearer JWT tokens  

## Request/Response Format

All API requests use the oRPC protocol with this structure:

```json
{
  "json": {
    // Your actual request data here
  },
  "meta": []
}
```

All responses follow this structure:

```json
{
  "json": {
    // Your actual response data here
  },
  "meta": []
}
```

## Authentication

### Register User

**Endpoint**: `POST /rpc/auth/register`

**Request**:
```json
{
  "json": {
    "email": "user@example.com",
    "password": "Password123!",
    "firstName": "John",
    "lastName": "Doe"
  },
  "meta": []
}
```

**Password Requirements**:
- Minimum 8 characters, maximum 128 characters
- Must contain: lowercase letter, uppercase letter, number, special character
- Allowed special characters: `@$!%*?&`

**Response** (200 OK):
```json
{
  "json": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "user-uuid",
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "createdAt": "2025-07-12T10:00:00.000Z",
      "lastLoginAt": "2025-07-12T10:00:00.000Z"
    }
  },
  "meta": []
}
```

**Error Responses**:
- `400 Bad Request`: Invalid email format or password requirements not met
- `409 Conflict`: Email already exists

### Login User

**Endpoint**: `POST /rpc/auth/login`

**Request**:
```json
{
  "json": {
    "email": "user@example.com",
    "password": "Password123!"
  },
  "meta": []
}
```

**Response** (200 OK):
```json
{
  "json": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "user-uuid",
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "createdAt": "2025-07-12T09:00:00.000Z",
      "lastLoginAt": "2025-07-12T10:00:00.000Z"
    }
  },
  "meta": []
}
```

**Error Responses**:
- `404 Not Found`: Invalid email or password
- `400 Bad Request`: Invalid request format

**JWT Token**:
- Expires in 24 hours
- Include in subsequent requests as: `Authorization: Bearer <token>`

## Test Templates

### List Available Tests

**Endpoint**: `POST /rpc/tests/list`

**Authentication**: Not required

**Request**:
```json
{
  "json": {},
  "meta": []
}
```

**Response** (200 OK):
```json
{
  "json": {
    "tests": [
      {
        "testId": "pga-tour-putting",
        "name": "PGA Tour Putting",
        "description": "Professional-level putting test with varied distances mimicking PGA tour conditions",
        "holeCount": 18,
        "distances": [1.5, 12.0, 0.6, 4.0, 1.2, 16.0, 8.0, 3.0, 6.0, 9.0, 0.9, 7.0, 2.1, 3.5, 10.0, 1.8, 5.0, 2.4]
      },
      {
        "testId": "putting-9",
        "name": "9-Hole Putting Test",
        "description": "Quick 9-hole putting test for shorter practice sessions",
        "holeCount": 9,
        "distances": [1.5, 12.0, 0.6, 4.0, 1.2, 16.0, 8.0, 3.0, 6.0]
      }
    ]
  },
  "meta": []
}
```

**Available Test Templates**:
- `pga-tour-putting`: 18-hole professional test
- `putting-18`: 18-hole standard test  
- `putting-9`: 9-hole quick test
- `short-game-6`: 6-hole short putts (under 5m)
- `long-range-6`: 6-hole long putts (over 5m)

### Create Test Template

**Endpoint**: `POST /rpc/tests/create`

**Authentication**: Not required

**Request**:
```json
{
  "json": {
    "testId": "custom-test-6",
    "name": "Custom 6-Hole Test",
    "description": "A personalized 6-hole putting test for practice",
    "holeCount": 6,
    "distances": [1.0, 2.5, 4.0, 6.5, 8.0, 12.0]
  },
  "meta": []
}
```

**Field Requirements**:
- `testId`: Unique identifier, lowercase letters, numbers, and hyphens only
- `name`: Display name (1-100 characters)
- `description`: Test description (1-500 characters)
- `holeCount`: Number of holes (1-18)
- `distances`: Array of distances in meters (0.1-50.0), must match `holeCount`

**Response** (200 OK):
```json
{
  "json": {
    "testId": "custom-test-6",
    "name": "Custom 6-Hole Test",
    "description": "A personalized 6-hole putting test for practice",
    "holeCount": 6,
    "distances": [1.0, 2.5, 4.0, 6.5, 8.0, 12.0],
    "createdAt": "2025-07-12T22:00:50.000Z"
  },
  "meta": []
}
```

**Error Responses**:
- `400 Bad Request`: Invalid data format, duplicate test ID, or validation errors
- `400 Bad Request`: Number of distances doesn't match hole count

**Validation Rules**:
- Test ID must be unique across all test templates
- Test ID format: `/^[a-z0-9-]+$/` (lowercase letters, numbers, hyphens only)
- Distance values must be between 0.1 and 50.0 meters
- Hole count must be between 1 and 18
- Number of distances must exactly match hole count

## Rounds Management

### Create Round

**Endpoint**: `POST /rpc/rounds/create`

**Authentication**: Required

**Request**:
```json
{
  "json": {
    "testId": "putting-9",
    "testName": "9-Hole Putting Test",
    "date": "2025-07-12T14:30:00.000Z",
    "holes": [
      { "hole": 1, "distance": 1.5, "putts": 2 },
      { "hole": 2, "distance": 12.0, "putts": 3 },
      { "hole": 3, "distance": 0.6, "putts": 1 }
    ]
  },
  "meta": []
}
```

**Field Requirements**:
- `testId`: Must match an existing test template
- `testName`: Display name for the test
- `date`: ISO 8601 timestamp
- `holes`: Array of hole results
  - `hole`: Hole number (1-based)
  - `distance`: Distance in meters (positive number)
  - `putts`: Number of putts (positive integer)

**Response** (200 OK):
```json
{
  "json": {
    "roundId": "round-uuid",
    "testId": "putting-9",
    "testName": "9-Hole Putting Test",
    "date": "2025-07-12T14:30:00.000Z",
    "totalPutts": 6,
    "holesCompleted": 3,
    "completedAt": "2025-07-12T14:35:00.000Z"
  },
  "meta": []
}
```

**Error Responses**:
- `401 Unauthorized`: Missing or invalid JWT token
- `400 Bad Request`: Invalid test ID or hole data
- `404 Not Found`: Test template not found

### List User Rounds

**Endpoint**: `POST /rpc/rounds/list`

**Authentication**: Required

**Request**:
```json
{
  "json": {
    "limit": 10,
    "offset": 0
  },
  "meta": []
}
```

**Parameters**:
- `limit`: Number of rounds to return (1-100, default: 10)
- `offset`: Number of rounds to skip (default: 0)

**Response** (200 OK):
```json
{
  "json": {
    "rounds": [
      {
        "roundId": "round-uuid-1",
        "testId": "putting-9",
        "testName": "9-Hole Putting Test",
        "date": "2025-07-12T14:30:00.000Z",
        "totalPutts": 18,
        "holesCompleted": 9,
        "completedAt": "2025-07-12T14:45:00.000Z"
      },
      {
        "roundId": "round-uuid-2",
        "testId": "pga-tour-putting",
        "testName": "PGA Tour Putting",
        "date": "2025-07-11T10:00:00.000Z",
        "totalPutts": 41,
        "holesCompleted": 18,
        "completedAt": "2025-07-11T10:30:00.000Z"
      }
    ],
    "pagination": {
      "total": 25,
      "limit": 10,
      "offset": 0,
      "hasMore": true
    }
  },
  "meta": []
}
```

**Error Responses**:
- `401 Unauthorized`: Missing or invalid JWT token
- `400 Bad Request`: Invalid pagination parameters

### Get Round Details

**Endpoint**: `POST /rpc/rounds/get`

**Authentication**: Required

**Request**:
```json
{
  "json": {
    "roundId": "round-uuid"
  },
  "meta": []
}
```

**Response** (200 OK):
```json
{
  "json": {
    "roundId": "round-uuid",
    "testId": "putting-9",
    "testName": "9-Hole Putting Test",
    "date": "2025-07-12T14:30:00.000Z",
    "totalPutts": 18,
    "holesCompleted": 9,
    "completedAt": "2025-07-12T14:45:00.000Z",
    "holes": [
      { "hole": 1, "distance": 1.5, "putts": 2 },
      { "hole": 2, "distance": 12.0, "putts": 3 },
      { "hole": 3, "distance": 0.6, "putts": 1 },
      { "hole": 4, "distance": 4.0, "putts": 2 },
      { "hole": 5, "distance": 1.2, "putts": 2 },
      { "hole": 6, "distance": 16.0, "putts": 3 },
      { "hole": 7, "distance": 8.0, "putts": 3 },
      { "hole": 8, "distance": 3.0, "putts": 2 },
      { "hole": 9, "distance": 6.0, "putts": 1 }
    ]
  },
  "meta": []
}
```

**Error Responses**:
- `401 Unauthorized`: Missing or invalid JWT token
- `404 Not Found`: Round not found or not owned by user
- `400 Bad Request`: Invalid round ID

## User Profile

### Get User Profile

**Endpoint**: `POST /rpc/user/profile`

**Authentication**: Required

**Request**:
```json
{
  "json": {},
  "meta": []
}
```

**Response** (200 OK):
```json
{
  "json": {
    "user": {
      "id": "user-uuid",
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "createdAt": "2025-07-12T09:00:00.000Z",
      "lastLoginAt": "2025-07-12T15:00:00.000Z"
    },
    "stats": {
      "totalRounds": 15,
      "totalPutts": 425,
      "averagePuttsPerRound": 28.33,
      "bestRound": {
        "roundId": "round-uuid",
        "totalPutts": 22,
        "date": "2025-07-10T14:30:00.000Z"
      },
      "recentActivity": {
        "lastRoundDate": "2025-07-12T14:30:00.000Z",
        "roundsThisWeek": 3,
        "roundsThisMonth": 8
      }
    }
  },
  "meta": []
}
```

**Error Responses**:
- `401 Unauthorized`: Missing or invalid JWT token

## Error Handling

### Common Error Response Format

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Password must contain lowercase, uppercase, number, and special character"
  }
}
```

### HTTP Status Codes

- `200 OK`: Successful request
- `400 Bad Request`: Invalid request data or validation errors
- `401 Unauthorized`: Missing, invalid, or expired JWT token
- `404 Not Found`: Resource not found or invalid credentials
- `409 Conflict`: Resource already exists (e.g., email during registration)
- `500 Internal Server Error`: Server error

### Common Error Codes

- `VALIDATION_ERROR`: Input validation failed
- `AUTHENTICATION_ERROR`: Invalid credentials
- `AUTHORIZATION_ERROR`: Insufficient permissions
- `NOT_FOUND`: Requested resource not found
- `CONFLICT`: Resource already exists
- `INTERNAL_ERROR`: Server error

## iOS Implementation Guide

### 1. HTTP Client Setup

```swift
// Base URL configuration
let baseURL = "http://localhost:3000"

// Request wrapper for oRPC format
struct ORPCRequest<T: Codable> {
    let json: T
    let meta: [String] = []
}

struct ORPCResponse<T: Codable> {
    let json: T
    let meta: [String]
}
```

### 2. Authentication Flow

```swift
// Store JWT token securely (Keychain recommended)
class AuthManager {
    private let tokenKey = "jwt_token"
    
    func storeToken(_ token: String) {
        // Store in Keychain
    }
    
    func getToken() -> String? {
        // Retrieve from Keychain
    }
    
    func clearToken() {
        // Remove from Keychain
    }
}
```

### 3. API Request Headers

```swift
var request = URLRequest(url: url)
request.httpMethod = "POST"
request.setValue("application/json", forHTTPHeaderField: "Content-Type")

// Add authentication header for protected endpoints
if let token = authManager.getToken() {
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
}
```

### 4. Data Models

```swift
struct User: Codable {
    let id: String
    let email: String
    let firstName: String
    let lastName: String
    let createdAt: String
    let lastLoginAt: String
}

struct TestTemplate: Codable {
    let testId: String
    let name: String
    let description: String
    let holeCount: Int
    let distances: [Double]
}

struct Round: Codable {
    let roundId: String
    let testId: String
    let testName: String
    let date: String
    let totalPutts: Int
    let holesCompleted: Int
    let completedAt: String
}

struct HoleResult: Codable {
    let hole: Int
    let distance: Double
    let putts: Int
}
```

### 5. Token Expiration Handling

JWT tokens expire after 24 hours. Implement automatic logout:

```swift
// Check token expiration before API calls
func isTokenExpired() -> Bool {
    // Decode JWT and check exp claim
    // Return true if expired
}

// Handle 401 responses
if response.statusCode == 401 {
    authManager.clearToken()
    // Navigate to login screen
}
```

### 6. Offline Support Considerations

- Cache test templates locally (they rarely change)
- Store incomplete rounds locally until network available
- Implement sync mechanism for when connectivity returns

## Security Notes

- Always use HTTPS in production
- Store JWT tokens securely (iOS Keychain)
- Implement proper token expiration handling
- Validate all user inputs on client side
- Use certificate pinning for enhanced security

## Rate Limiting

The API doesn't currently implement rate limiting, but consider implementing client-side throttling for better user experience and to prepare for future server-side limits.

## Demo Data

The server includes demo data that can be used for testing:

**Demo User**:
- Email: `demo@putting-test.com`
- Password: `Demo123!`

This user has sample rounds already created for testing purposes.