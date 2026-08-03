import baseConfig from "./hardhat.config.js";

// Coverage is intentionally limited to deployable protocol sources. Solidity helpers under
// contracts/test build proof fixtures and must not inflate the assurance percentage.
export default {
  ...baseConfig,
  coverage: {
    skipFiles: ["contracts/test/**"],
  },
};
