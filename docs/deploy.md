# Building and shipping

One codebase, built with EAS. Nothing secret is compiled into the app: the OpenRouter key and any
source keys are typed in on the phone and kept in the Keystore / Keychain.

## One-time setup (needs your accounts, so it was not done during the build)

1. `npm install -g eas-cli`, then `eas login`.
2. `eas init` in the repo. It creates the EAS project and prints its ID.
3. Make the ID available as `EAS_PROJECT_ID`:
   - locally: add `EAS_PROJECT_ID=<id>` to `.env` (git-ignored);
   - on EAS: `eas env:create --name EAS_PROJECT_ID --value <id> --environment production --environment preview --environment development --visibility plaintext`;
   - on GitHub: a repository variable `EAS_PROJECT_ID`, and a secret `EXPO_TOKEN`
     (from expo.dev, Access tokens).

   `app.config.ts` reads it to set the EAS Update URL. Without it the app runs its embedded bundle
   and over-the-air updates are simply off.
4. Android: create the app in Play Console with package `net.dsc.newsreader`, add yourself to the
   internal testing track, and give EAS a service-account key the first time `eas submit` asks.
5. iOS: `eas credentials` (or let the first `eas build` do it) to create the distribution
   certificate and profile for bundle ID `net.dsc.newsreader`; `eas submit` asks for the App Store
   Connect API key once.

The package and bundle ID are set in `app.config.ts`. Change them there before the first store
upload if you want something else; they cannot be changed afterwards.

## Day to day

| Task | Command |
| --- | --- |
| Android to Play internal testing | `eas build --platform android --profile production` then `eas submit --platform android` |
| iOS to TestFlight | `eas build --platform ios --profile production` then `eas submit --platform ios` |
| Both, in one go | `eas build --platform all --profile production --auto-submit` |
| APK for sideloading | `eas build --platform android --profile preview` |
| Development build (dev client) | `eas build --profile development --platform android` (or `ios`) |
| JavaScript-only update to both phones | `eas update --channel production --message "what changed"` |
| Build on the Mac instead of the cloud | add `--local` to any `eas build` |

Pushing a tag `vX.Y.Z` runs the tests and then the production build and submit for both platforms
(`.github/workflows/ci.yml`). Every push runs typecheck and the Jest suite.

An EAS Update reaches a phone only if its installed build has the same runtime version, which is
the app `version` in `app.config.ts`. Bump `version` whenever native code or native dependencies
change, and ship a store build for it.

## Local builds without EAS

```
npx expo prebuild --platform android      # generates android/ (git-ignored)
cd android && ./gradlew assembleRelease   # APK in app/build/outputs/apk/release
```

The template signs release APKs with the debug keystore, which is fine for an emulator or
sideloading to your own phone, not for Play.

## End-to-end tests

See [testing.md](testing.md). The flows need the E2E build variant (`E2E=1` at prebuild and build
time, or the `e2e` EAS profile), which allows plain HTTP to the local mock server and enables the
`newsreader://e2e` hook. Production builds have neither.
