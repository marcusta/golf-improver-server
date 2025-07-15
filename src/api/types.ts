// A simple payload to store in the Hono context after auth
export type UserPayload = {
  id: string;
};

// This defines the shape of the variables you can set and get on the context
export type AppContext = {
  Variables: {
    user: UserPayload;
  };
};
