import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHonoApp } from "../app";
import { createTestDatabase } from "../testing/server";
import {
  cleanTestEnvironment,
  createTestDataSet,
  setupTestEnvironment,
  type TestDataSet,
} from "../testing/test-helpers";

describe("Putting Test Suite API", () => {
  let database: Database;
  let app: ReturnType<typeof createHonoApp>["app"];
  let testData: TestDataSet;

  beforeEach(async () => {
    setupTestEnvironment();
    database = await createTestDatabase();
    const { app: honoApp } = createHonoApp(database);
    app = honoApp;
    testData = await createTestDataSet(database);
  });

  afterEach(() => {
    database.close();
    cleanTestEnvironment();
  });

  async function makeRequest(
    path: string,
    payload: any,
    method = "POST",
    token?: string | null,
  ) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const body = JSON.stringify(payload);
    return await app.request(path, { method, headers, body });
  }

  describe("Authentication", () => {
    test("should register a new user", async () => {
      const response = await makeRequest("/rpc/auth/register", {
        email: "newuser@example.com",
        password: "Password123!",
        firstName: "New",
        lastName: "User",
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.access_token).toBeDefined();
      expect(data.refresh_token).toBeDefined();
      expect(data.expires_in).toBe(3600);
      expect(data.token_type).toBe("Bearer");
      expect(data.user.email).toBe("newuser@example.com");
      expect(data.user.first_name).toBe("New");
      expect(data.user.last_name).toBe("User");
    });

    test("should login existing user", async () => {
      const response = await makeRequest("/rpc/auth/login", {
        email: "test@example.com",
        password: "Password123!",
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.access_token).toBeDefined();
      expect(data.refresh_token).toBeDefined();
      expect(data.expires_in).toBe(3600);
      expect(data.token_type).toBe("Bearer");
      expect(data.user.email).toBe("test@example.com");
      expect(data.user.first_name).toBeDefined();
      expect(data.user.last_name).toBeDefined();
    });

    test("should reject invalid credentials", async () => {
      const response = await makeRequest("/rpc/auth/login", {
        email: "test@example.com",
        password: "wrongpassword",
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("invalid_credentials");
    });

    test("should refresh access token", async () => {
      // First login to get refresh token
      const loginResponse = await makeRequest("/rpc/auth/login", {
        email: "test@example.com",
        password: "Password123!",
      });
      const loginData = await loginResponse.json();

      // Wait a bit to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 100));

      // Use refresh token to get new access token
      const refreshResponse = await makeRequest("/rpc/auth/refresh", {
        refresh_token: loginData.refresh_token,
      });

      expect(refreshResponse.status).toBe(200);
      const refreshData = await refreshResponse.json();
      expect(refreshData.access_token).toBeDefined();
      expect(refreshData.refresh_token).toBeDefined();
      expect(refreshData.expires_in).toBe(3600);
      expect(refreshData.token_type).toBe("Bearer");
      
      // New refresh token should be different from original (contains random payload)
      expect(refreshData.refresh_token).not.toBe(loginData.refresh_token);
      // Access token might be same if generated in same second, but should be valid
      expect(refreshData.access_token).toBeDefined();
      expect(refreshData.access_token.length).toBeGreaterThan(0);
    });

    test("should reject invalid refresh token", async () => {
      const response = await makeRequest("/rpc/auth/refresh", {
        refresh_token: "invalid-token",
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("invalid_refresh_token");
    });

    test("should logout and invalidate refresh token", async () => {
      // First login to get refresh token
      const loginResponse = await makeRequest("/rpc/auth/login", {
        email: "test@example.com",
        password: "Password123!",
      });
      const loginData = await loginResponse.json();

      // Logout
      const logoutResponse = await makeRequest("/rpc/auth/logout", {
        refresh_token: loginData.refresh_token,
      });

      expect(logoutResponse.status).toBe(200);
      const logoutData = await logoutResponse.json();
      expect(logoutData.message).toBe("Successfully logged out");

      // Try to use the refresh token again - should fail
      const refreshResponse = await makeRequest("/rpc/auth/refresh", {
        refresh_token: loginData.refresh_token,
      });

      expect(refreshResponse.status).toBe(401);
      const refreshData = await refreshResponse.json();
      expect(refreshData.error).toBe("invalid_refresh_token");
    });

    test("should reject logout with invalid token", async () => {
      const response = await makeRequest("/rpc/auth/logout", {
        refresh_token: "invalid-token",
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("invalid_refresh_token");
    });
  });

  describe("Test Templates", () => {
    test("should list available tests", async () => {
      const response = await makeRequest("/rpc/tests/list", {});

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.tests).toBeDefined();
      expect(data.tests.length).toBeGreaterThan(0);
      expect(data.tests[0]).toHaveProperty("testId");
      expect(data.tests[0]).toHaveProperty("name");
      expect(data.tests[0]).toHaveProperty("distances");
    });

    test("should create a new test template", async () => {
      const testTemplate = {
        testId: "custom-test-3",
        name: "Custom 3-Hole Test",
        description: "A quick 3-hole test for beginners",
        holeCount: 3,
        distances: [1.0, 2.5, 4.0],
      };

      const response = await makeRequest("/rpc/tests/create", testTemplate);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.testId).toBe("custom-test-3");
      expect(data.name).toBe("Custom 3-Hole Test");
      expect(data.description).toBe("A quick 3-hole test for beginners");
      expect(data.holeCount).toBe(3);
      expect(data.distances).toEqual([1.0, 2.5, 4.0]);
      expect(data.createdAt).toBeDefined();
    });

    test("should reject duplicate test template ID", async () => {
      const testTemplate = {
        testId: "putting-9", // This ID already exists from seed data
        name: "Duplicate Test",
        description: "This should fail",
        holeCount: 2,
        distances: [1.0, 2.0],
      };

      const response = await makeRequest("/rpc/tests/create", testTemplate);

      expect(response.status).toBe(400);
    });

    test("should validate test template data", async () => {
      const invalidTemplate = {
        testId: "", // Empty ID
        name: "",   // Empty name
        description: "",  // Empty description
        holeCount: 0,     // Invalid hole count
        distances: [],    // Empty distances
      };

      const response = await makeRequest("/rpc/tests/create", invalidTemplate);

      expect(response.status).toBe(400);
    });

    test("should validate distances match hole count", async () => {
      const mismatchedTemplate = {
        testId: "mismatched-test",
        name: "Mismatched Test",
        description: "Hole count doesn't match distances",
        holeCount: 3,
        distances: [1.0, 2.0], // Only 2 distances for 3 holes
      };

      const response = await makeRequest("/rpc/tests/create", mismatchedTemplate);

      expect(response.status).toBe(400);
    });

    test("should validate test ID format", async () => {
      const invalidIdTemplate = {
        testId: "Invalid_ID_With_Capitals_And_Underscores",
        name: "Invalid ID Test",
        description: "Test with invalid ID format",
        holeCount: 2,
        distances: [1.0, 2.0],
      };

      const response = await makeRequest("/rpc/tests/create", invalidIdTemplate);

      expect(response.status).toBe(400);
    });

    test("should validate distance ranges", async () => {
      const invalidDistanceTemplate = {
        testId: "invalid-distance-test",
        name: "Invalid Distance Test",
        description: "Test with invalid distance values",
        holeCount: 2,
        distances: [0.05, 55.0], // Too small and too large
      };

      const response = await makeRequest("/rpc/tests/create", invalidDistanceTemplate);

      expect(response.status).toBe(400);
    });
  });

  describe("Rounds Management", () => {
    let authToken: string;

    beforeEach(async () => {
      const loginResponse = await makeRequest("/rpc/auth/login", {
        email: "test@example.com",
        password: "Password123!",
      });
      const loginData = await loginResponse.json();
      authToken = loginData.access_token;
    });

    test("should create a new round", async () => {
      const roundData = {
        testId: "putting-9",
        testName: "9-Hole Putting Test",
        date: new Date().toISOString(),
        holes: [
          { hole: 1, distance: 1.5, putts: 2 },
          { hole: 2, distance: 12.0, putts: 3 },
          { hole: 3, distance: 0.6, putts: 1 },
        ],
      };

      const response = await makeRequest(
        "/rpc/rounds/create",
        roundData,
        "POST",
        authToken,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.roundId).toBeDefined();
      expect(data.testId).toBe("putting-9");
      expect(data.totalPutts).toBe(6);
    });

    test("should list user rounds", async () => {
      const response = await makeRequest(
        "/rpc/rounds/list",
        { limit: 10, offset: 0 },
        "POST",
        authToken,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.rounds).toBeDefined();
      expect(data.pagination).toBeDefined();
      expect(data.pagination.total).toBeGreaterThanOrEqual(0);
    });

    test("should get round details", async () => {
      const roundId = testData.rounds.testRound1.id;

      const response = await makeRequest(
        "/rpc/rounds/get",
        { roundId },
        "POST",
        authToken,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.roundId).toBe(roundId);
      expect(data.holes).toBeDefined();
      expect(Array.isArray(data.holes)).toBe(true);
    });

    test("should reject unauthorized access", async () => {
      const response = await makeRequest("/rpc/rounds/list", {
        limit: 10,
        offset: 0,
      });

      expect(response.status).toBe(401);
    });
  });

  describe("User Profile", () => {
    let authToken: string;

    beforeEach(async () => {
      const loginResponse = await makeRequest("/rpc/auth/login", {
        email: "test@example.com",
        password: "Password123!",
      });
      const loginData = await loginResponse.json();
      authToken = loginData.access_token;
    });

    test("should get user profile with stats", async () => {
      const response = await makeRequest(
        "/rpc/user/profile",
        {},
        "POST",
        authToken,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.user).toBeDefined();
      expect(data.user.email).toBe("test@example.com");
      expect(data.stats).toBeDefined();
      expect(data.stats.totalRounds).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Data Validation", () => {
    test("should validate email format in registration", async () => {
      const response = await makeRequest("/rpc/auth/register", {
        email: "invalid-email",
        password: "Password123!",
        firstName: "Test",
        lastName: "User",
      });

      expect(response.status).toBe(400);
    });

    test("should validate password requirements", async () => {
      const response = await makeRequest("/rpc/auth/register", {
        email: "test@example.com",
        password: "weak", // Missing uppercase, number, special char
        firstName: "Test",
        lastName: "User",
      });

      expect(response.status).toBe(400);
    });
  });
});
