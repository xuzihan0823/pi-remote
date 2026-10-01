# Pi Remote iOS build

The iOS directory now contains a minimal native SwiftUI application, an Xcode
project and a shared `PiRemote` scheme. Its deployment target is iOS 17.0.
The initial screen is a build and launch baseline; Relay connection, session
browsing and prompting are not implemented in this app yet.

## Build on GitHub Actions

The `iOS Build` workflow runs on GitHub's `macos-15` runner when these files
change on `main`, a `codex/ios-*` branch, or a pull request. After the workflow
reaches the default branch it can also be started with **Run workflow** in
the repository's Actions tab.

The job runs Xcode's actual simulator build, creates an isolated iPhone
simulator, installs the app, launches it and verifies the app process remains
running. It deletes only the simulator it created.

Successful runs upload:

- `PiRemote-iOS-simulator`: a `PiRemote-simulator.tar.gz` app archive, a
  simulator screenshot and the launch log.
- `PiRemote-iOS-build-diagnostics`: the build log and Xcode result bundle.

Artifacts are retained for 14 days. Extract the archive on a Mac and install
it into a booted simulator:

```bash
tar -xzf PiRemote-simulator.tar.gz
xcrun simctl install booted PiRemote.app
xcrun simctl launch booted com.xuzihan0823.PiRemote
```

## Build on a Mac

Install Xcode and an iPhone simulator runtime. From the repository root:

```bash
bash scripts/build-ios.sh
# Build, install and launch on a new temporary simulator:
bash scripts/build-ios.sh --smoke-test
```

Each invocation writes a new directory under `.build/ios/run.*`; build
outputs are ignored by Git. `IOS_BUILD_DIR` can select another output root.
You can also open `ios/PiRemote/PiRemote.xcodeproj` in Xcode.

## Device builds

The CI output is a simulator application, not an IPA for a physical iPhone.
Simulator builds do not require Apple credentials. To install on a real
device, select your signing team in Xcode and use an appropriate bundle ID
and provisioning profile. App Store/TestFlight releases additionally need
the release icon and distribution signing configuration.

Linux can edit this project and run the Relay's Node tests, but cannot run
the Apple iOS SDK or Xcode compiler. A local validation of the project format
does not establish that the iOS build passed; use the macOS job's result.
