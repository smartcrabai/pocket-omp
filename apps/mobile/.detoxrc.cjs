/** @type {Detox.DetoxConfig} */
module.exports = {
  testRunner: {
    args: { $0: "jest", config: "e2e/jest.config.cjs" },
    jest: { setupTimeout: 180000 },
  },
  apps: {
    "ios.release": {
      type: "ios.app",
      binaryPath: "ios/build/Build/Products/Release-iphonesimulator/PocketOMP.app",
      build:
        "xcodebuild -workspace ios/PocketOMP.xcworkspace -scheme PocketOMP -configuration Release -sdk iphonesimulator -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO",
    },
  },
  devices: {
    simulator: { type: "ios.simulator", device: { type: "iPhone 16 Pro" } },
  },
  configurations: {
    "ios.sim.release": { device: "simulator", app: "ios.release" },
  },
};
