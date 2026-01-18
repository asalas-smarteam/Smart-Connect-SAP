export default {
  testEnvironment: "node",
  clearMocks: true,
  extensionsToTreatAsEsm: [".js"],
  moduleFileExtensions: ["js", "json"],
  testMatch: [
    "**/__tests__/**/*.test.js",
    "**/?(*.)+(spec|test).js"
  ],
  transform: {}
};
